import { sourceMayLog } from '../../shared/free-privacy.ts';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Adapter, ExecuteContext, ModelInfo, RuntimeSnapshot, RuntimeTarget } from '../../shared/types.js';
import { StartupTail, spawnTarget, terminateProcess, redactError, runtimeError } from './process.js';
import { auditNativeProcess, auditNativeProtocolMetadata, auditPermissionConfig } from './execution-audit.ts';
import { apiEnvironment, readApiKey } from '../api-providers.js';
import { probeFreeSource, syncFreeSourceConfig, retryAfterSeconds } from '../free-sources.ts';
export { retryAfterSeconds } from '../free-sources.ts';
import { apiPreset, validateApiConnection } from '../../shared/api-providers.js';
import { apiCatalog, mergeApiModels } from '../api-model-discovery.ts';
import { safeToolEventText, safeToolEventValue, toolEventDetails } from '../../shared/tool-event-data.ts';
import { trustedCommandTurn } from '../../shared/permission-reason.ts';
import { hostBridgeToolNames as piBridgeToolNames } from './host-bridge.ts';
import { currentHost, type Host } from '../platform/host.ts';
import { managedNodeRuntime } from '../platform/node-runtime.ts';
import { executorImage } from '../attachment-image.ts';
import {
  estimateImageCostUsd,
  ImageApiError,
  maxImageReferences,
  maxImagesPerBatch,
  openAiImageEndpoint,
  openAiImages,
} from '../image-generation.ts';
import { supportedOpenAiImageModel, type GeneratedImage } from '../../shared/image-generation.ts';

/** Image attachments as Pi RPC ImageContent blocks; routing sends images only to a model whose catalog reads them. */
export async function piPromptImages(ctx: ExecuteContext): Promise<{ text: string; images: Row[] }> {
  const images = (ctx.input.attachments ?? []).filter((attachment) => attachment.kind === 'image');
  const result = { text: ctx.input.prompt, images: [] as Row[] };
  const budget = { bytes: 0 };
  for (const image of images) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType))
      throw new Error('runtime-image-input-invalid');
    const selected = await executorImage(image, 'pi', ctx, budget).catch(() => {
      throw new Error('runtime-image-input-invalid');
    });
    if (!selected) {
      result.text += `\n${image.name}：图片像素未提供，原件仍保留在 ${image.path}。`;
      continue;
    }
    const bytes = await readFile(selected.path).catch(() => {
      throw new Error('runtime-image-input-invalid');
    });
    result.images.push({ type: 'image', data: bytes.toString('base64'), mimeType: selected.mimeType });
  }
  return result;
}

/** The tools a run that may change files gets; Pi's PowerShell tool exists only on Windows. */
export function piWritableTools(host: Host = currentHost()): string[] {
  return ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', ...(host.platform === 'win32' ? ['powershell'] : [])];
}
export { hostBridgeToolNames as piBridgeToolNames } from './host-bridge.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const protections = [
  '--mode',
  'rpc',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-approve',
];
const note =
  'Pi 是本地模型执行组件，使用 Pi 配置或环境变量中的底层模型凭据，不自动继承原生 CLI 登录。模型目录发现不代表实际推理已验证；Pi 自身没有独立余额。自动模式在可信项目的可写任务里也执行命令，其他情况仅允许工作区内文件工具；确认模式逐项审批。Pi 没有操作系统沙箱，只读模式保留原有工具行为。';
const permissionCommand = 'studio-permissions-v1';
const hostBridgeCommand = 'studio-host-bridge-v1';
const budgetCommand = 'studio-api-budget-v1';
const codemodeCommand = 'studio-codemode-v1';
const removedGatewayMessage = 'Magpie 网关已移除，请选择原生 CLI 或已配置的 API 执行器';
const retiredTarget = (target: RuntimeTarget) => target.gateway === 'magpie' || target.id === 'pi-magpie';

export async function piPermissionExtensionPath(): Promise<string> {
  const directory = dirname(fileURLToPath(import.meta.url));
  // The server is one bundle in dist/server; during development this module is in src/server/adapters.
  for (const path of [join(directory, 'pi-extension.mjs'), resolve(directory, '../pi-extension.mjs')]) {
    try {
      await access(path);
      return path;
    } catch {
      /* Try the source layout next. */
    }
  }
  throw new Error('runtime-permission-or-sandbox-error');
}

export function makePiTarget(root: string, dataDir = join(root, '.data')): RuntimeTarget {
  return {
    id: 'pi-local',
    provider: 'pi',
    label: 'Pi · native RPC',
    command: managedNodeRuntime(root),
    args: [
      join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      '--session-dir',
      join(dataDir, 'pi', 'sessions'),
    ],
    // Ambient Pi/API credentials are not an opt-in to automatic paid inference.
    environment: 'native',
    enabled: false,
    commandDiscovery: 'auto',
  };
}

function sessionDirectory(target: RuntimeTarget): string {
  const index = target.args?.indexOf('--session-dir') ?? -1;
  return index >= 0 && target.args?.[index + 1] ? resolve(target.args[index + 1]!) : resolve('.data/pi/sessions');
}

/** Reflect Pi's getSupportedThinkingLevels using the native model metadata. */
export function piModels(payload: unknown, defaults: Record<string, string> = {}): ModelInfo[] {
  const models = object(payload).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((item): ModelInfo[] => {
    const model = object(item),
      id = string(model.id),
      provider = string(model.provider);
    if (!id || !provider) return [];
    const mapping = object(model.thinkingLevelMap);
    let efforts =
      model.reasoning === true
        ? levels.filter(
            (level) => mapping[level] !== null && (!['xhigh', 'max'].includes(level) || mapping[level] !== undefined),
          )
        : ['off'];
    const compat = object(model.compat);
    if (model.reasoning === true && compat.supportsReasoningEffort === false) {
      const format = compat.thinkingFormat;
      if (typeof format === 'string' && format !== 'openai') {
        const on = efforts.includes('high') ? 'high' : efforts.find((level) => level !== 'off');
        efforts = [...(efforts.includes('off') ? ['off'] : []), ...(on ? [on] : [])];
      } else if (format === 'openai') efforts = ['off'];
    }
    const cost = object(model.cost);
    const price =
      typeof cost.input === 'number' && typeof cost.output === 'number'
        ? { price: { input: cost.input, output: cost.output } }
        : {};
    return [
      {
        id: `${provider}/${id}`,
        label: `${string(model.name) || id} · ${provider}`,
        efforts,
        ...(defaults[provider] === id ? { catalogDefault: true } : {}),
        ...price,
        imageInput: Array.isArray(model.input) && model.input.includes('image'),
      },
    ];
  });
}

type Dependencies = {
  probe: typeof probeFreeSource;
  key: typeof readApiKey;
  spawn: typeof spawnTarget;
  terminate: typeof terminateProcess;
  canonicalPath: (path: string) => Promise<string>;
  permissionExtension: () => Promise<string>;
  version: (target: RuntimeTarget) => Promise<string | undefined>;
  environment: (target: RuntimeTarget) => NodeJS.ProcessEnv;
  catalogDefaults: (state: unknown) => Record<string, string>;
  bridgeTools: (bridge: NonNullable<ExecuteContext['agentBridge']>, signal: AbortSignal) => Promise<string[]>;
  fetch: typeof fetch;
};
const dependencies: Dependencies = {
  probe: probeFreeSource,
  key: readApiKey,
  spawn: spawnTarget,
  terminate: terminateProcess,
  canonicalPath: realpath,
  permissionExtension: piPermissionExtensionPath,
  environment: (target) => environment(target),
  // On a single-provider API card, Pi's initial model is that provider's catalog default.
  catalogDefaults: (state) => {
    const model = object(object(state).model);
    const provider = string(model.provider),
      id = string(model.id);
    return provider && id ? { [provider]: id } : {};
  },
  bridgeTools: piBridgeToolNames,
  fetch: (input, init) => fetch(input, init),
  version: async (target) => {
    const cli = target.args?.[0];
    if (!cli) return undefined;
    const metadata = object(JSON.parse(await readFile(resolve(dirname(cli), '../../package.json'), 'utf8')));
    return metadata.name === '@earendil-works/pi-coding-agent' ? string(metadata.version) || undefined : undefined;
  },
};

/**
 * The provider refuses this account the chosen model: Zhipu 1220 「您无权访问…」, OpenAI-style model_not_found.
 * Only an otherwise unclassified failure is upgraded, so key, quota and network causes keep their own codes.
 */
export function modelAccessRefused(raw: unknown): boolean {
  if (redactError(raw) !== 'runtime-request-failed') return false;
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  if (redactError(text) !== 'runtime-request-failed') return false;
  return /(?:^|[{,\s])["']?code["']?\s*[:=]\s*["']?1220(?!\d)|无权(?:访问|使用).{0,80}模型|model_not_found|do(?:es)? not have access to (?:the )?model|\bmodel\b.{0,80}does not exist or you do not have access/i.test(
    text,
  );
}

function providerError(raw: unknown, options: Parameters<typeof runtimeError>[1] = {}): Error {
  const retry = retryAfterSeconds(raw);
  return Object.assign(
    runtimeError(raw, {
      provider: 'Pi',
      ...options,
      ...(modelAccessRefused(raw) ? { code: 'runtime-model-unavailable' } : {}),
    }),
    retry === undefined ? {} : { retryAfterSeconds: retry },
  );
}

class PiChannel {
  private buffer = '';
  private closed = false;
  private waiters = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  onEvent: (event: Row) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  readonly startup = new StartupTail();
  private terminalError?: Error;
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly errorOptions: Parameters<typeof runtimeError>[1] = {},
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.startup.write('stdout', chunk);
      this.buffer += chunk;
      // JSONL is LF-delimited; U+2028/U+2029 inside a string are not record separators.
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        if (line.length > 8 * 1024 * 1024) {
          this.fail(new Error('runtime-protocol-incompatible'));
          return;
        }
        let packet: Row;
        try {
          packet = object(JSON.parse(line));
        } catch {
          continue;
        }
        if (packet.type === 'response') {
          const id = string(packet.id),
            waiter = this.waiters.get(id);
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          this.waiters.delete(id);
          if (packet.success === true) waiter.resolve(packet.data);
          else waiter.reject(providerError(packet.error, this.errorOptions));
        } else this.onEvent(packet);
      }
      if (this.buffer.length > 8 * 1024 * 1024) this.fail(new Error('runtime-protocol-incompatible'));
    });
    child.stderr.on('data', (chunk: Buffer) => this.startup.write('stderr', chunk));
    child.on('error', (error) => this.fail(new Error(redactError(error))));
    child.stdin.on('error', (error) => {
      if (!this.startup.active) this.fail(new Error(redactError(error)));
    });
    child.on('close', (code) =>
      this.fail(
        this.startup.active
          ? this.startup.failure('Pi', code ?? null, this.errorOptions)
          : new Error('runtime-process-closed'),
      ),
    );
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    this.onFailure(error);
  }
  request(type: string, fields: Row = {}, timeoutMs = 10_000): Promise<unknown> {
    if (this.closed) return Promise.reject(this.terminalError ?? new Error('runtime-process-closed'));
    return new Promise((resolveRequest, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error('runtime-timeout'));
      }, timeoutMs);
      this.waiters.set(id, { resolve: resolveRequest, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...fields, id, type })}\n`);
    });
  }
  respondToExtension(id: string, response: { confirmed?: boolean; cancelled?: boolean }): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...response })}\n`);
  }
  dispose(): void {
    this.child.stdin.end();
    this.fail(new Error('runtime-process-closed'));
  }
}

function environment(target: RuntimeTarget): NodeJS.ProcessEnv {
  if (retiredTarget(target)) throw new Error(removedGatewayMessage);
  if (target.gateway === 'api') {
    const preset = apiPreset(target.apiProvider);
    if (!preset) throw new Error('api-key-auth-or-configuration');
    return apiEnvironment(target, preset, preset.local ? undefined : readApiKey(target.id));
  }
  // Preserve PI_CODING_AGENT_DIR and provider authentication; only session storage is isolated.
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
}

/** An API platform's executor offers only that platform's models, labelled without the runtime's provider id. */
function targetModels(target: RuntimeTarget, payload: unknown, defaults: Record<string, string> = {}): ModelInfo[] {
  if (target.apiProvider === 'meta-model-api') defaults = { ...defaults, 'pugport-meta': 'muse-spark-1.3' };
  const models = piModels(payload, defaults);
  if (target.gateway !== 'api') return models;
  const prefix = `${apiPreset(target.apiProvider)?.runtimeProvider}/`;
  return mergeApiModels(
    target,
    models
      .filter((model) => model.id.startsWith(prefix))
      .map((model) => ({ ...model, label: model.label.replace(/ · [^·]+$/, '') })),
  );
}

function quota(): RuntimeSnapshot['quota'] {
  return {
    status: 'unknown',
    source: 'Pi RPC',
    observedAt: new Date().toISOString(),
    windows: [],
    note: 'Pi 只报告 token 和费用，不报告订阅余额，也不会用 token 推算余额。',
  };
}

function modelParts(model: string): { provider: string; modelId: string } {
  const separator = model.indexOf('/');
  if (separator < 1 || separator === model.length - 1) throw new Error('runtime-protocol-incompatible');
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

/** The executor is Pi; the configured API platform and confirmed model remain distinct. */
export function piModelAuditDetails(ctx: ExecuteContext, method: string, phase: string, state: Row = {}): unknown {
  const connection = ctx.target.apiConnection ? validateApiConnection(ctx.target.apiConnection) : undefined;
  const observedModel = object(state.model),
    confirmedModel: Row = {};
  for (const field of ['provider', 'id', 'name', 'api'])
    if (typeof observedModel[field] === 'string') confirmedModel[field] = safeToolEventText(observedModel[field], 512);
  for (const field of ['contextWindow', 'maxTokens'])
    if (typeof observedModel[field] === 'number' && Number.isFinite(observedModel[field]))
      confirmedModel[field] = observedModel[field];
  if (typeof observedModel.reasoning === 'boolean') confirmedModel.reasoningSupported = observedModel.reasoning;
  return safeToolEventValue({
    executor: ctx.target.label,
    provider: 'pi',
    runtimeId: ctx.target.id,
    transport: 'pi-rpc',
    method,
    phase,
    executionPath: ctx.target.gateway === 'api' ? 'api' : 'pi-native-config',
    ...(ctx.target.gateway === 'api' && ctx.target.apiProvider
      ? { configuredApiPlatform: ctx.target.apiProvider }
      : {}),
    ...(connection
      ? {
          apiConnection: {
            protocol: connection.protocol,
            endpoint: connection.baseUrl,
            model: connection.model,
            ...(connection.protocol === 'azure-openai-responses' ? { deployment: connection.model } : {}),
            pricingSource: connection.price ? 'user-estimate' : 'unknown',
            ...(connection.price
              ? { price: connection.price, cacheRead: connection.price.input, cacheWrite: connection.price.input * 2 }
              : {}),
          },
          budgetDecision: ctx.apiBudget ? { allowed: true, ...ctx.apiBudget } : { configured: false },
        }
      : {}),
    requestedModel: modelParts(ctx.route.model),
    ...(ctx.route.effort ? { requestedEffort: ctx.route.effort } : {}),
    ...(Object.keys(confirmedModel).length ? { confirmedModel } : {}),
    ...(typeof state.thinkingLevel === 'string' ? { confirmedThinkingLevel: state.thinkingLevel } : {}),
  });
}

async function checkedSession(target: RuntimeTarget, session: string, deps: Dependencies): Promise<string> {
  if (!isAbsolute(session) || !session.endsWith('.jsonl')) throw new Error('runtime-protocol-incompatible');
  const [root, file] = await Promise.all([deps.canonicalPath(sessionDirectory(target)), deps.canonicalPath(session)]);
  const inside = relative(root, file);
  if (
    !inside ||
    inside === '..' ||
    inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(inside)
  )
    throw new Error('runtime-permission-or-sandbox-error');
  return file;
}

/** Home and profile folders of the user running PugPort, for a trusted turn's commands (git, gh, npm config). */
const userHome = () =>
  Object.fromEntries(
    ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']
      .map((name) => [name, process.env[name]] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
  );

const listingMaxAgeMs = 10 * 60_000;
/**
 * Everything an API card's Pi listing is read from; the key enters only as part of the digest. The overrides are
 * compared by content: each launch rewrites the same file, which changes its time and nothing else.
 */
async function apiListingKey(target: RuntimeTarget, result: RuntimeSnapshot, key: string | undefined) {
  const overrides = target.agentDir
    ? await readFile(join(target.agentDir, 'models.json'), 'utf8').catch(() => 'none')
    : 'none';
  return createHash('sha256')
    .update(JSON.stringify([target, result.version ?? null, result.capabilities.approvals, overrides, key ?? null]))
    .digest('hex');
}

export function createPiAdapter(overrides: Partial<Dependencies> = {}): Adapter {
  const deps = { ...dependencies, ...overrides };
  const listings = new Map<string, { key: string; at: number; defaults: Record<string, string>; available: unknown }>();
  return {
    async discover(target) {
      const result: RuntimeSnapshot = {
        id: target.id,
        provider: 'pi',
        gateway: target.gateway,
        label: target.label,
        environment: target.environment,
        installed: false,
        status: 'missing',
        models: [],
        quota: quota(),
        note,
        capabilities: { execute: true, resume: true, cancel: true, approvals: false, steer: true, toolless: true },
        refreshedAt: new Date().toISOString(),
      };
      if (retiredTarget(target)) {
        result.gateway = 'magpie';
        result.status = 'error';
        result.note = removedGatewayMessage;
        result.capabilities = { execute: false, resume: false, cancel: false, approvals: false, steer: false };
        return result;
      }
      const api = target.gateway === 'api';
      if (api) {
        // API executors show product wording only; usage and balance are on the executors page.
        result.apiProvider = target.apiProvider;
        result.apiConnection = target.apiConnection;
        result.note = undefined;
        result.quota = { ...result.quota, note: undefined };
        const preset = apiPreset(target.apiProvider);
        if (preset?.tier === 'free') {
          result.costTier = 'free';
          result.local = preset.local === true;
          result.mayLog = preset.id === 'custom' ? target.apiMayLog !== false : preset.mayLog;
          const probe = await deps.probe(target, preset.local ? undefined : deps.key(target.id));
          result.installed = probe.error !== 'runtime-network-error';
          result.status =
            probe.error === 'authentication-required'
              ? 'auth-required'
              : probe.error
                ? preset.local
                  ? 'missing'
                  : 'error'
                : probe.models.length
                  ? 'ready'
                  : 'unknown';
          result.note = probe.error;
          if (probe.error) {
            if (probe.error === 'quota-or-rate-limit')
              result.availability = {
                reason: 'quota',
                observedAt: result.refreshedAt,
                retryAt: new Date(Math.min(Date.now() + (probe.retryAfterSeconds ?? 60) * 1000, 8.64e15)).toISOString(),
              };
            return result;
          }
          result.models = probe.models.map((model) => ({
            id: `${preset.runtimeProvider}/${model.id}`,
            label: model.name,
            efforts: ['off'],
            price: { input: 0, output: 0 },
          }));
          if (!target.enabled) return result;
          syncFreeSourceConfig(target, probe.models);
        }
        if (!preset?.keyless && !deps.key(target.id)) {
          result.installed = true;
          result.status = 'auth-required';
          try {
            if ((preset?.endpoint || preset?.id === 'custom-api') && preset.tier !== 'free')
              result.models = targetModels(target, { models: apiCatalog(target) }).filter((model) => !model.discovered);
          } catch {
            result.status = 'error';
          }
          return result;
        }
      }
      let channel: PiChannel | undefined;
      try {
        result.capabilities.approvals = await deps.permissionExtension().then(
          () => true,
          () => false,
        );
        if (!result.capabilities.approvals && !api)
          result.note = `${note} Permission extension is missing; workspace-write will be rejected until the application is rebuilt.`;
        result.version = await deps.version(target);
        // An API card's listing is what Pi reads from the card's own settings, key and models.json. A card with a
        // running task is observed every 15 s and again when the task ends; starting a Pi process each time held
        // the backend for most of a second to learn nothing new. The listing is kept until one of its inputs changes.
        // Free sources are listed from a live probe of the source itself, and keyless ones have no key to read.
        const preset = apiPreset(target.apiProvider);
        const keyed = api && preset?.tier !== 'free' && !preset?.keyless;
        const listingKey = () => apiListingKey(target, result, deps.key(target.id));
        const kept = keyed ? listings.get(target.id) : undefined;
        let listing: { defaults: Record<string, string>; available: unknown };
        if (kept && Date.now() - kept.at < listingMaxAgeMs && kept.key === (await listingKey())) listing = kept;
        else {
          const child = await deps.spawn(target, [...protections, '--no-context-files', '--no-tools', '--no-session'], {
            env: deps.environment(target),
          });
          result.installed = true;
          channel = new PiChannel(child, {
            provider: `Pi · ${apiPreset(target.apiProvider)?.label ?? target.provider}`,
            secrets: [api && !apiPreset(target.apiProvider)?.keyless ? deps.key(target.id) : undefined],
            paths: [target.agentDir],
          });
          let stateRead = false;
          const defaults = await channel
            .request('get_state', {}, 25_000)
            .then((state) => {
              channel!.startup.done();
              stateRead = true;
              return deps.catalogDefaults(state);
            })
            .catch(() => ({})); // The initial model is optional discovery metadata.
          listing = { defaults, available: await channel.request('get_available_models', {}, 25_000) };
          // Only a complete, usable listing is kept: a failed or empty read is tried again next time. Its inputs
          // are taken after the read, since the launch itself may have written the overrides.
          if (keyed && stateRead && targetModels(target, listing.available, defaults).length)
            listings.set(target.id, { key: await listingKey(), at: Date.now(), ...listing });
          else listings.delete(target.id);
        }
        result.installed = true;
        result.models = targetModels(target, listing.available, listing.defaults);
        result.status = result.models.length ? 'ready' : 'auth-required';
        // Images go only to models whose catalog entry reads them; routing checks the chosen model too.
        result.capabilities.imageInput = result.models.some((model) => model.imageInput === true);
        if (!result.models.length && !api)
          result.note = `${note} No configured model is available. Run the local Pi CLI and /login, then refresh. CLI subscriptions are not copied into Pi automatically.`;
      } catch (error) {
        const reason = redactError(error);
        result.installed ||= Boolean(result.version);
        result.status =
          reason === 'runtime-not-found'
            ? 'missing'
            : reason === 'authentication-required' ||
                reason === 'api-key-auth-or-configuration' ||
                reason === 'api-key-workspace-required'
              ? 'auth-required'
              : 'error';
        result.note = api ? undefined : `${note} Discovery: ${reason}.`;
      } finally {
        if (channel) {
          channel.dispose();
          await deps.terminate(channel.child);
        }
      }
      return result;
    },
    async execute(ctx) {
      if (ctx.input.imageGeneration) return executeImageBatch(ctx, deps);
      const preset = apiPreset(ctx.target.apiProvider);
      const unknownPrice =
        ctx.target.gateway === 'api' &&
        preset?.tier !== 'free' &&
        (preset?.id === 'custom-api'
          ? !validateApiConnection(ctx.target.apiConnection).price
          : !!preset?.endpoint &&
            !apiCatalog(ctx.target).some((model) => `${preset.runtimeProvider}/${model.id}` === ctx.route.model));
      if (ctx.apiBudget && unknownPrice) throw new Error('api-budget-usage-unknown');
      if (ctx.signal.aborted) throw new Error('operation-cancelled');
      if (retiredTarget(ctx.target)) throw new Error(removedGatewayMessage);
      // Tool-less: every built-in, extension and custom tool off, no AGENTS.md/CLAUDE.md, no host bridge. The
      // extension still loads for an API budget, whose guard registers no tools.
      if (
        sourceMayLog(ctx.target) &&
        (!ctx.input.textOnly ||
          !ctx.input.textOnlyPrompt?.trim() ||
          ctx.input.prompt !== ctx.input.textOnlyPrompt ||
          ctx.input.attachments?.length ||
          ctx.input.permissionMode !== 'read-only')
      )
        throw new Error('privacy-text-only');
      const toolless = ctx.input.untrustedContent === true || ctx.input.textOnly === true;
      const writable = ctx.input.permissionMode === 'workspace-write' && !toolless;
      const approvalMode = ctx.approvalMode === 'auto' ? 'auto' : 'ask';
      const trustedCommands =
        writable && approvalMode === 'auto' && trustedCommandTurn(ctx.input, ctx.trustedProject === true);
      const budget = ctx.apiBudget;
      const cutoff = budget?.expiresAt === undefined ? undefined : Date.parse(budget.expiresAt);
      if (
        budget &&
        (!Number.isFinite(budget.maxCostUsd) ||
          budget.maxCostUsd <= 0 ||
          (cutoff !== undefined && !Number.isFinite(cutoff)))
      )
        throw new Error('runtime-permission-or-sandbox-error');
      if (cutoff !== undefined && Date.now() >= cutoff) throw new Error('api-budget-expired');
      const bridge = ctx.input.visualAssistant || toolless ? undefined : ctx.agentBridge;
      const hostTools = bridge ? await deps.bridgeTools(bridge, ctx.signal) : [];
      const extension = !toolless || budget ? await deps.permissionExtension() : undefined;
      const args = [
        ...protections,
        ...(ctx.input.factCheck ? ['--no-context-files'] : []),
        ...(toolless
          ? ['--no-tools', '--no-context-files']
          : [
              '--tools',
              [
                ...(writable
                  ? piWritableTools().filter(
                      (tool) => ctx.input.prohibitCommands !== true || !['bash', 'powershell'].includes(tool),
                    )
                  : ['read', 'grep', 'find', 'ls']),
                'codemode',
                ...hostTools.map((name) => `pugport_${name}`),
              ].join(','),
            ]),
      ];
      if (extension) args.push('--extension', extension);
      if (ctx.nativeSessionId) args.push('--session', await checkedSession(ctx.target, ctx.nativeSessionId, deps));
      const child = await deps.spawn(ctx.target, args, {
        sandbox: ctx.sandbox,
        onSandboxFailure: ctx.onSandboxFailure,
        onSandboxSuccess: ctx.onSandboxSuccess,
        signal: ctx.signal,
        runTemp: ctx.runTemp,
        cwd: ctx.input.projectPath,
        env: {
          ...deps.environment(ctx.target),
          COMBORUNNER_TOOL_APPROVAL_MODE: approvalMode,
          COMBORUNNER_PI_PERMISSION_MODE: writable ? 'workspace-write' : 'read-only',
          COMBORUNNER_PI_PROHIBIT_COMMANDS: ctx.input.prohibitCommands === true ? '1' : '',
          COMBORUNNER_PI_TRUSTED_COMMANDS: trustedCommands ? '1' : '',
          // The user's own home folders for commands; never credentials.
          COMBORUNNER_PI_USER_HOME: trustedCommands ? JSON.stringify(userHome()) : '',
          COMBORUNNER_PI_CODEMODE: toolless ? '' : 'on',
          // Clear ambient bridge data; only this live run's temporary token may be used.
          COMBORUNNER_AGENT_BRIDGE_URL: bridge?.url ?? '',
          COMBORUNNER_AGENT_BRIDGE_TOKEN: bridge?.token ?? '',
          COMBORUNNER_AGENT_BRIDGE_TOOLS: bridge ? JSON.stringify(hostTools) : '',
          COMBORUNNER_PI_API_BUDGET: budget ? JSON.stringify(budget) : '',
        },
      });
      auditNativeProcess(ctx, child, args, 'pi-rpc');
      auditPermissionConfig(ctx, 'process/spawn', 'requested', {
        approvalMode,
        permissionExtensionEnabled: !!extension,
        tools: toolless ? 'none' : args[args.indexOf('--tools') + 1],
        cwd: ctx.input.projectPath,
      });
      const errorOptions = {
        provider: `Pi · ${apiPreset(ctx.target.apiProvider)?.label ?? modelParts(ctx.route.model).provider}`,
        secrets: [ctx.target.gateway === 'api' ? deps.key(ctx.target.id) : undefined, ctx.agentBridge?.token],
        paths: [ctx.dataDir, ctx.target.agentDir],
        prompt: ctx.input.prompt,
      };
      const channel = new PiChannel(child, errorOptions);
      let output = '',
        nativeSessionId: string | undefined,
        currentText = '',
        messageStart = 0;
      // Per-request observation fields: when the turn began and the model's window.
      let requestStartedAt: string | undefined, contextWindow: number | undefined;
      let failure: Error | undefined,
        settled = false,
        requested = false;
      let observedCost = 0;
      let cutoffTimer: ReturnType<typeof setTimeout> | undefined;
      let permissionsReady = false,
        disposing = false;
      const pendingApprovals = new Set<string>();
      const answeredApprovals = new Set<string>();
      const answerApproval = (id: string, response: { confirmed?: boolean; cancelled?: boolean }) => {
        if (answeredApprovals.has(id)) return;
        answeredApprovals.add(id);
        pendingApprovals.delete(id);
        channel.respondToExtension(id, response);
      };
      let cancellation: Promise<void> | undefined;
      let resolveDone!: () => void, rejectDone!: (error: Error) => void;
      const done = new Promise<void>((resolveDoneValue, rejectDoneValue) => {
        resolveDone = resolveDoneValue;
        rejectDone = rejectDoneValue;
      });
      // A process may fail during the initial RPC setup, before execution awaits done.
      void done.catch(() => {});
      const emit = (type: Parameters<ExecuteContext['emit']>[0]['type'], text?: string, data?: Row) =>
        ctx.emit({ at: new Date().toISOString(), type, text, data });
      const modelAudit = (method: string, phase: string, state: Row = {}) => {
        emit('status', phase === 'requested' ? 'Pi 正在请求选择底层模型。' : 'Pi 已返回模型状态。', {
          source: 'native',
          kind:
            phase === 'requested'
              ? 'model-request'
              : string(object(state.model).provider) && string(object(state.model).id)
                ? 'model-confirmed'
                : 'protocol-observation',
          detail: piModelAuditDetails(ctx, method, phase, state),
        });
      };
      const cancel = () => {
        ctx.registerSteer?.(undefined, { state: 'finishing' });
        for (const id of pendingApprovals) answerApproval(id, { cancelled: true });
        cancellation ??= (async () => {
          await channel.request('clear_queue', {}, 500).catch(() => {});
          await channel.request('abort', {}, 500).catch(() => {});
          channel.dispose();
        })();
        rejectDone(failure?.message.startsWith('api-budget-') ? failure : new Error('operation-cancelled'));
      };
      const stopForBudget = (reason: 'api-budget-exhausted' | 'api-budget-expired' | 'api-budget-usage-unknown') => {
        if (settled || disposing || failure?.message.startsWith('api-budget-')) return;
        failure = new Error(reason);
        ctx.endTools?.();
        emit('error', reason, { source: 'pugport', reason, executionBlocked: true, observedCostUsd: observedCost });
        cancel();
      };
      channel.onFailure = (error) => {
        ctx.registerSteer?.(undefined, { state: 'finishing' });
        if (!settled) rejectDone(error);
      };
      const deniedCommands = new Set<string>();
      let commandHandoff = false;
      let commandNotice = false;
      channel.onEvent = (packet) => {
        if (
          ![
            'message_start',
            'message_update',
            'message_end',
            'tool_execution_start',
            'tool_execution_update',
            'tool_execution_end',
            'extension_ui_request',
          ].includes(string(packet.type))
        )
          auditNativeProtocolMetadata(
            ctx,
            packet,
            [
              'agent_start',
              'turn_start',
              'turn_end',
              'agent_end',
              'agent_settled',
              'auto_compaction_start',
              'auto_compaction_end',
              'auto_retry_start',
              'auto_retry_end',
            ].includes(string(packet.type)),
          );
        if (packet.type === 'extension_ui_request') {
          const id = string(packet.id),
            method = string(packet.method);
          const notification = string(packet.message);
          if (
            method === 'notify' &&
            writable &&
            approvalMode === 'auto' &&
            !trustedCommands &&
            notification.startsWith('pugport-command-untrusted:')
          ) {
            deniedCommands.add(notification.slice('pugport-command-untrusted:'.length));
            return;
          }
          if (
            method === 'notify' &&
            budget &&
            (notification === 'api-budget-exhausted' ||
              notification === 'api-budget-expired' ||
              notification === 'api-budget-usage-unknown')
          ) {
            stopForBudget(notification);
            return;
          }
          if (method !== 'confirm') auditNativeProtocolMetadata(ctx, packet, false, method);
          if (!id || pendingApprovals.has(id) || answeredApprovals.has(id)) return;
          if (method === 'confirm') {
            if (
              !writable ||
              approvalMode === 'auto' ||
              !permissionsReady ||
              !requested ||
              settled ||
              disposing ||
              ctx.signal.aborted
            ) {
              emit('status', 'Pi 拒绝了超出当前权限配置的确认请求。', {
                source: 'Pi host permission boundary',
                decision: 'deny',
                approvalMode,
                nativeMethod: 'extension_ui_request/confirm',
                nativePromptId: safeToolEventText(id, 512),
                ...(string(packet.toolCallId) ? { toolCallId: safeToolEventText(string(packet.toolCallId), 512) } : {}),
              });
              answerApproval(id, { cancelled: true });
              return;
            }
            pendingApprovals.add(id);
            void (async () => {
              let allow = false;
              try {
                allow = await ctx.approve(
                  string(packet.title).slice(0, 300) || 'Pi tool',
                  string(packet.message).slice(0, 20000),
                );
              } catch {
                /* Approval failures deny this individual call. */
              }
              if (!disposing && !settled && !ctx.signal.aborted) {
                if (!allow)
                  emit('status', 'Pi 的操作确认未获批准。', {
                    source: 'Pi host approval',
                    decision: 'deny',
                    approvalMode,
                    nativeMethod: 'extension_ui_request/confirm',
                    nativePromptId: safeToolEventText(id, 512),
                    ...(string(packet.toolCallId)
                      ? { toolCallId: safeToolEventText(string(packet.toolCallId), 512) }
                      : {}),
                  });
                answerApproval(id, { confirmed: allow });
              } else answerApproval(id, { cancelled: true });
            })().finally(() => pendingApprovals.delete(id));
          } else if (['select', 'input', 'editor'].includes(method)) answerApproval(id, { cancelled: true });
          return;
        }
        if (!requested) return;
        const message = object(packet.message);
        if (packet.type === 'turn_start') requestStartedAt = new Date().toISOString();
        if (packet.type === 'message_start' && message.role === 'assistant') {
          currentText = '';
          messageStart = output.length;
          requestStartedAt ??= new Date().toISOString();
        }
        if (packet.type === 'message_update') {
          const delta = object(packet.assistantMessageEvent);
          if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
            currentText += delta.delta;
            output += delta.delta;
            emit('text', delta.delta);
          }
        }
        if (packet.type === 'message_end' && message.role === 'assistant') {
          const content = Array.isArray(message.content) ? message.content : [];
          const finalText = content
            .map((part) => (object(part).type === 'text' ? string(object(part).text) : ''))
            .join('');
          if (finalText && finalText.startsWith(currentText)) {
            const suffix = finalText.slice(currentText.length);
            if (suffix) emit('text', suffix);
          }
          if (finalText) output = output.slice(0, messageStart) + finalText;
          const usage = object(message.usage),
            data: Row = {
              source: 'Pi RPC',
              cumulative: false,
              scope: 'assistant-message',
              eventId: `pi-${message.id || message.timestamp || randomUUID()}`,
              // A failed or aborted request reports no real occupancy; the ledger records it as not reported.
              ...(message.stopReason === 'error' || message.stopReason === 'aborted'
                ? { stopReason: message.stopReason }
                : {}),
              ...(requestStartedAt ? { requestStartedAt } : {}),
              ...(contextWindow ? { contextWindow } : {}),
            };
          requestStartedAt = undefined;
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'])
            if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) data[key] = usage[key];
          const cost = object(usage.cost).total;
          if (!unknownPrice && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
            data.costUsd = cost;
            observedCost += cost;
            if (budget && observedCost >= budget.maxCostUsd) stopForBudget('api-budget-exhausted');
          } else if (budget) stopForBudget('api-budget-usage-unknown');
          if (Object.keys(data).length > 3) emit('usage', undefined, data);
          if (!failure?.message.startsWith('api-budget-'))
            failure =
              message.stopReason === 'error'
                ? providerError(message.errorMessage, errorOptions)
                : message.stopReason === 'aborted'
                  ? new Error('operation-cancelled')
                  : undefined;
        }
        if (
          packet.type === 'tool_execution_start' ||
          packet.type === 'tool_execution_update' ||
          packet.type === 'tool_execution_end'
        )
          emit(
            'tool',
            `${safeToolEventText(string(packet.toolName), 256) || 'tool'}: ${packet.type === 'tool_execution_start' ? 'started' : packet.type === 'tool_execution_update' ? 'updated' : typeof packet.isError !== 'boolean' ? 'result observed' : packet.isError === true ? 'failed' : 'finished'}`,
            {
              ...(string(packet.toolCallId) &&
              string(packet.toolCallId).length <= 512 &&
              safeToolEventText(string(packet.toolCallId), 512) === packet.toolCallId
                ? { toolCallId: string(packet.toolCallId) }
                : {}),
              kind: 'nativeToolCall',
              ...(deniedCommands.has(string(packet.toolCallId)) ? { commandNotExecuted: true } : {}),
              tool: safeToolEventText(string(packet.toolName), 256),
              status:
                packet.type !== 'tool_execution_end'
                  ? 'inProgress'
                  : typeof packet.isError !== 'boolean'
                    ? 'unknown'
                    : packet.isError === true
                      ? 'failed'
                      : 'completed',
              ...(packet.type === 'tool_execution_end' && packet.isError === true ? { isError: true } : {}),
              ...(packet.type === 'tool_execution_update' ? { partial: true } : {}),
              ...(string(packet.parentToolCallId) &&
              string(packet.parentToolCallId).length <= 512 &&
              safeToolEventText(string(packet.parentToolCallId), 512) === packet.parentToolCallId
                ? { parentToolCallId: string(packet.parentToolCallId) }
                : {}),
              ...toolEventDetails({
                args: packet.args,
                result: packet.type === 'tool_execution_update' ? packet.partialResult : packet.result,
              }),
            },
          );
        if (packet.type === 'tool_execution_end' && deniedCommands.has(string(packet.toolCallId)) && !commandNotice) {
          commandNotice = true;
          commandHandoff = ctx.commandDenied?.() === true;
          if (commandHandoff) cancel();
        }
        if (packet.type === 'auto_retry_start') emit('status', 'Pi 正在重试模型请求。');
        if (packet.type === 'auto_retry_end' && packet.success === false && !failure?.message.startsWith('api-budget-'))
          failure = providerError(packet.finalError, errorOptions);
        if (packet.type === 'agent_settled') {
          settled = true;
          ctx.registerSteer?.(undefined, { state: 'finishing' });
          if (failure) rejectDone(failure);
          else if (packet.aborted === true) rejectDone(new Error('operation-cancelled'));
          else resolveDone();
        }
      };
      ctx.signal.addEventListener('abort', cancel, { once: true });
      try {
        if (ctx.signal.aborted) throw new Error('operation-cancelled');
        if (extension) {
          const commands = object(await channel.request('get_commands')).commands;
          permissionsReady =
            Array.isArray(commands) &&
            commands.some(
              (command) => object(command).name === permissionCommand && object(command).source === 'extension',
            );
          auditPermissionConfig(ctx, 'get_commands', 'observed', {
            permissionsReady,
            ...(permissionsReady ? { permissionCommand, permissionCommandSource: 'extension' } : {}),
          });
          if (!permissionsReady) throw new Error('runtime-permission-or-sandbox-error');
          if (
            !toolless &&
            !(
              Array.isArray(commands) &&
              commands.some(
                (command) => object(command).name === codemodeCommand && object(command).source === 'extension',
              )
            )
          )
            throw new Error('runtime-permission-or-sandbox-error');
          if (
            budget &&
            !(
              Array.isArray(commands) &&
              commands.some(
                (command) => object(command).name === budgetCommand && object(command).source === 'extension',
              )
            )
          )
            throw new Error('runtime-permission-or-sandbox-error');
          if (bridge) {
            const hostReady =
              Array.isArray(commands) &&
              commands.some(
                (command) => object(command).name === hostBridgeCommand && object(command).source === 'extension',
              );
            emit('status', hostReady ? 'Pi 已接入本次任务的 PugPort 宿主工具。' : 'Pi 宿主工具桥未完成验证。', {
              source: 'pugport',
              kind: 'host-tool-bridge',
              detail: { ready: hostReady, tools: hostTools, permissionMode: ctx.input.permissionMode },
            });
            if (!hostReady) throw new Error('runtime-permission-or-sandbox-error');
          }
        }
        const models = targetModels(ctx.target, await channel.request('get_available_models', {}, 25_000));
        const selected = models.find((model) => model.id === ctx.route.model);
        if (!selected) throw new Error('authentication-required');
        // The live catalog wins over the routed snapshot: never send pixels to a model that no longer reads them.
        if (selected.imageInput === false && ctx.input.attachments?.some((file) => file.kind === 'image'))
          throw new Error('runtime-image-input-unavailable');
        modelAudit('set_model', 'requested');
        const selectedModel = object(await channel.request('set_model', modelParts(ctx.route.model)));
        modelAudit('set_model', 'response', { model: selectedModel });
        const available = object(await channel.request('get_available_thinking_levels')).levels;
        if (ctx.route.effort) {
          if (!Array.isArray(available) || !available.includes(ctx.route.effort))
            throw new Error('runtime-protocol-incompatible');
          await channel.request('set_thinking_level', { level: ctx.route.effort });
        }
        const initialState = object(await channel.request('get_state'));
        channel.startup.done();
        const reportedWindow = object(initialState.model).contextWindow;
        if (typeof reportedWindow === 'number' && Number.isFinite(reportedWindow) && reportedWindow > 0)
          contextWindow = reportedWindow;
        modelAudit('get_state', 'initial', initialState);
        nativeSessionId = string(initialState.sessionFile) || undefined;
        if (nativeSessionId) emit('session', undefined, { nativeSessionId });
        if (ctx.signal.aborted) throw new Error('operation-cancelled');
        if (cutoff !== undefined) {
          if (Date.now() >= cutoff) throw new Error('api-budget-expired');
          const checkCutoff = () => {
            const remaining = cutoff - Date.now();
            if (remaining <= 0) stopForBudget('api-budget-expired');
            else cutoffTimer = setTimeout(checkCutoff, Math.min(remaining, 2_147_483_647));
          };
          cutoffTimer = setTimeout(checkCutoff, Math.min(cutoff - Date.now(), 2_147_483_647));
        }
        emit(
          'status',
          toolless
            ? 'Pi 以纯聊天方式启动：没有任何工具，只根据收到的文字回答。'
            : ctx.input.prohibitCommands === true
              ? 'Pi command tools are disabled for this run, including nested Code Mode calls. File tools retain the selected permission scope.'
              : writable
                ? trustedCommands
                  ? 'Pi 在可信项目里自动执行文件工具和命令；命令看不到 API 密钥和 PugPort 内部变量，工作区外的文件工具仍会拒绝，本轮不提供 PugPort 网页搜索。'
                  : approvalMode === 'auto'
                    ? 'Pi 自动执行工作区内文件工具，不弹出逐条确认。工作区外路径、shell 和未知工具会自动拒绝；Pi 没有操作系统沙箱，需要 shell 的任务请使用 Codex 原生执行器。'
                    : 'Pi RPC started with per-tool host approval. Every file or shell operation requires an individual decision; Pi has no OS sandbox.'
                : 'Pi RPC started with read, grep, find and ls tools. Write and shell tools are disabled.',
        );
        const content = await piPromptImages(ctx);
        requested = true;
        await channel.request('prompt', {
          message: content.text,
          ...(content.images.length ? { images: content.images } : {}),
        });
        if (!settled && !ctx.signal.aborted)
          ctx.registerSteer?.(async (prompt) => {
            if (settled || disposing || ctx.signal.aborted) throw new Error('runtime-steering-unavailable');
            // Pi queues this input before the next LLM call, after the current tool batch; it is not a follow-up turn.
            await channel.request('steer', { message: prompt });
            // An idle Pi also accepts steer into its queue. A terminal event that
            // precedes the acknowledgment cannot prove delivery to this execution.
            if (settled || disposing || ctx.signal.aborted) throw new Error('runtime-steering-unavailable');
          });
        await done; // agent_end may precede retry/compaction; only agent_settled is final.
        const finalState = object(await channel.request('get_state'));
        modelAudit('get_state', 'final', finalState);
        nativeSessionId = string(finalState.sessionFile) || nativeSessionId;
        return { nativeSessionId, output };
      } catch (error) {
        if (commandHandoff && !ctx.signal.aborted) return { nativeSessionId, output };
        const retry = (error as { retryAfterSeconds?: number })?.retryAfterSeconds;
        if (typeof retry === 'number' && Number.isFinite(retry))
          emit('status', undefined, { retryAfterSeconds: retry });
        if (failure?.message.startsWith('api-budget-')) throw failure;
        if (ctx.signal.aborted) throw new Error('operation-cancelled');
        throw error;
      } finally {
        disposing = true;
        ctx.endTools?.();
        clearTimeout(cutoffTimer);
        ctx.registerSteer?.(undefined, { state: 'finishing' });
        for (const id of pendingApprovals) answerApproval(id, { cancelled: true });
        ctx.signal.removeEventListener('abort', cancel);
        await cancellation;
        channel.dispose();
        await deps.terminate(child);
      }
    },
  };
}

/**
 * Image generation on an API card. Pi's own image API (pi-ai images-api-registry) implements only OpenRouter's image
 * models, and its OpenAI catalog lists no gpt-image model, so an OpenAI card calls the Images API directly with the
 * card's own stored key. The key never reaches an event, an error or the run output.
 */
/** API image calls in flight at once for one batch. */
const imageBatchConcurrency = 4;

async function executeImageBatch(ctx: ExecuteContext, deps: Dependencies) {
  const request = ctx.input.imageGeneration!;
  const prompts = (request.prompts?.length ? request.prompts : [request.prompt]).slice(0, maxImagesPerBatch);
  const budget = ctx.apiBudget;
  // The only spending bound is the card's remaining credit. perRunUsd is an admission reservation, not a cap.
  const limit = budget?.maxCostUsd ?? Infinity;
  const cutoff = budget?.expiresAt === undefined ? undefined : Date.parse(budget.expiresAt);
  if (
    (budget && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd <= 0)) ||
    (cutoff !== undefined && !Number.isFinite(cutoff))
  )
    throw new Error('runtime-permission-or-sandbox-error');
  if (cutoff !== undefined && Date.now() >= cutoff) throw new Error('api-budget-expired');
  const abort = new AbortController();
  const signal = AbortSignal.any([ctx.signal, abort.signal]);
  let spent = 0;
  let stopped: string | undefined;
  const stop = (reason: string) => {
    stopped = reason;
    abort.abort();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchExpiry = () => {
    if (cutoff === undefined) return;
    if (Date.now() >= cutoff) stop('api-budget-expired');
    else timer = setTimeout(watchExpiry, Math.min(2_147_483_647, cutoff - Date.now()));
  };
  watchExpiry();
  const fail = (index: number, prompt: string, reason: string) => {
    ctx.emit({
      at: new Date().toISOString(),
      type: 'status',
      data: {
        source: 'pugport',
        kind: 'image-batch-failure',
        detail: { index: index + 1, prompt: safeToolEventText(prompt), error: reason },
      },
    });
    return { error: reason };
  };
  const draw = async (prompt: string, index: number) => {
    if (stopped) return fail(index, prompt, stopped);
    try {
      const result = await executeImages(
        {
          ...ctx,
          signal,
          input: {
            ...ctx.input,
            imageGeneration: {
              ...request,
              prompt,
              // Each picture sends only its own references; one with none is drawn from words alone.
              ...(request.referenceSets?.[index]
                ? {
                    references: request.referenceSets[index]!.flatMap((at) =>
                      request.references?.[at] ? [request.references[at]!] : [],
                    ),
                  }
                : {}),
            },
          },
          emit: (event) => {
            ctx.emit(event);
            if (event.type === 'usage' && typeof event.data?.costUsd === 'number') {
              spent += event.data.costUsd;
              // In-flight requests may already be billed; retain their usage and any completed images.
              if (spent >= limit) stop('api-budget-exhausted');
            }
          },
        },
        deps,
        ctx.target.apiBudget?.perRunUsd ?? 0,
      );
      const title = request.titles?.[index];
      return {
        result: { ...result, generatedImages: result.generatedImages.map((image) => ({ ...image, title })) },
      };
    } catch (error) {
      return fail(index, prompt, stopped ?? (error instanceof Error ? error.message : 'runtime-request-failed'));
    }
  };
  try {
    // A few at a time: a whole document of prompts at once would only meet the platform's rate limit.
    const results: Array<Awaited<ReturnType<typeof draw>>> = new Array(prompts.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(imageBatchConcurrency, prompts.length) }, async () => {
        while (next < prompts.length) {
          const index = next++;
          results[index] = await draw(prompts[index]!, index);
        }
      }),
    );
    if (ctx.signal.aborted) throw new Error('operation-cancelled');
    const successes = results.flatMap((item) => ('result' in item && item.result ? [item.result] : []));
    if (!successes.length) throw new Error(results.find((item) => 'error' in item)?.error ?? 'image-output-missing');
    return {
      ...successes[0]!,
      generatedImages: successes.flatMap((item) => item.generatedImages).slice(0, maxImagesPerBatch),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function executeImages(ctx: ExecuteContext, deps: Dependencies, fallbackUsd: number) {
  const request = ctx.input.imageGeneration!;
  const preset = apiPreset(ctx.target.apiProvider);
  if (
    ctx.target.gateway !== 'api' ||
    preset?.images !== 'openai-images' ||
    !preset.endpoint ||
    !request.model ||
    !supportedOpenAiImageModel(request.model)
  )
    throw new Error('runtime-image-generation-unavailable');
  if (ctx.signal.aborted) throw new Error('operation-cancelled');
  const key = deps.key(ctx.target.id);
  if (!key) throw new Error('authentication-required');
  const references = request.references ?? [];
  const sent = Math.min(references.length, maxImageReferences);
  // What goes over the wire, exactly: the owner's own words, so keeping them in the local record is fine.
  ctx.emit({
    at: new Date().toISOString(),
    type: 'status',
    text: `调用 ${request.model} 生成图片`,
    data: {
      source: 'pugport',
      kind: 'image-request',
      detail: {
        model: request.model,
        endpoint: openAiImageEndpoint(sent),
        references: sent,
        edit: request.edit,
        prompt: safeToolEventText(request.prompt),
      },
    },
  });
  let result: Awaited<ReturnType<typeof openAiImages>>;
  try {
    result = await openAiImages({
      key,
      baseUrl: preset.endpoint.baseUrl,
      model: request.model,
      prompt: request.prompt,
      references,
      outputDir: request.outputDir,
      signal: ctx.signal,
      fetch: deps.fetch,
    });
  } catch (error) {
    if (ctx.signal.aborted) throw new Error('operation-cancelled');
    throw new Error(error instanceof ImageApiError ? error.message : 'runtime-request-failed');
  }
  const costUsd = estimateImageCostUsd(result.usage, fallbackUsd);
  ctx.emit({
    at: new Date().toISOString(),
    type: 'usage',
    data: {
      source: 'OpenAI Images API',
      cumulative: false,
      scope: 'assistant-message',
      eventId: `openai-images-${randomUUID()}`,
      ...(result.usage
        ? {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
            totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          }
        : {}),
      costUsd,
      costEstimate: true,
    },
  });
  const images: GeneratedImage[] = result.images.map(({ bytes: _bytes, ...image }) => ({
    ...image,
    executor: ctx.target.label,
    runtimeId: ctx.target.id,
    tool: 'api-images',
    imageModel: request.model!,
  }));
  for (const [index, image] of images.entries())
    ctx.emit({
      at: new Date().toISOString(),
      type: 'status',
      text: `${ctx.target.label} 用 ${request.model} 生成了一张图片`,
      data: {
        source: 'pugport',
        kind: 'image-generation',
        detail: {
          executor: safeToolEventText(ctx.target.label, 256),
          runtimeId: safeToolEventText(ctx.target.id, 512),
          imageModel: safeToolEventText(request.model!, 256),
          tool: image.tool,
          mimeType: image.mimeType,
          path: safeToolEventText(image.path),
          bytes: result.images[index]!.bytes,
          ...(image.revisedPrompt ? { revisedPrompt: safeToolEventText(image.revisedPrompt) } : {}),
        },
      },
    });
  return {
    output: images[0]?.revisedPrompt ? `已生成图片。模型改写后的提示：${images[0].revisedPrompt}` : '已生成图片。',
    generatedImages: images,
    effectiveModel: { model: request.model, source: 'OpenAI Images API' },
  };
}

export const piAdapter = createPiAdapter();
