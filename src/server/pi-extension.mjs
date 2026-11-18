import './platform/under-test.mjs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const permissionCommand = 'studio-permissions-v1';
export const hostBridgeCommand = 'studio-host-bridge-v1';
export const budgetCommand = 'studio-api-budget-v1';
export const codemodeCommand = 'studio-codemode-v1';
const fileTools = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write']);
const shellTools = new Set(['bash', 'powershell']);
const blocked = (reason) => ({ block: true, reason });
/** Credentials and PugPort internals a command must never see: tests would bill the card's key outside its budget. */
const hiddenFromCommands =
  /^(?:COMBORUNNER_|PUGPORT_)|^ELECTRON_RUN_AS_NODE$|API_?KEY|SECRET|ACCESS_KEY|SESSION_TOKEN/i;
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A trusted turn's command, preceded by removing those variables and restoring the user's own home folders (the API
 * card's process points HOME at its private folder). Pi passes its whole environment to commands.
 */
export function commandForTrustedTurn(tool, command, env = process.env) {
  const drop = Object.keys(env).filter((name) => variableName.test(name) && hiddenFromCommands.test(name));
  let home = {};
  try {
    home = JSON.parse(env.COMBORUNNER_PI_USER_HOME || '{}');
  } catch {
    home = {};
  }
  const restore = Object.entries(home).filter(([name, value]) => variableName.test(name) && typeof value === 'string');
  if (tool === 'powershell') {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    const lines = [
      ...drop.map((name) => `Remove-Item -LiteralPath Env:${name} -ErrorAction SilentlyContinue`),
      ...restore.map(([name, value]) => `$env:${name} = ${quote(value)}`),
    ];
    return lines.length ? `${lines.join('; ')}; ${command}` : command;
  }
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const lines = [
    ...(drop.length ? [`unset ${drop.join(' ')}`] : []),
    ...restore.map(([name, value]) => `export ${name}=${quote(value)}`),
  ];
  return lines.length ? [...lines, command].join('\n') : command;
}

/** Reuse Pi's isolated runner; extra model calls must go through the host's routed, metered tools. */
export async function registerPiCodemode(pi) {
  const { createCodemodeExtension } = await import('@earendil-works/pi-coding-agent');
  createCodemodeExtension({ mode: 'on', models: false })(pi);
  pi.registerCommand(codemodeCommand, {
    description: 'PugPort mixed Code Mode with host permissions and no direct model calls v1',
    handler: async (_args, ctx) => ctx.ui.notify('PugPort Code Mode ready.', 'info'),
  });
}

/** Local cost estimates can stop later requests; a provider hard limit remains the billing boundary. */
export function registerPiBudgetGuard(pi, budget, now = Date.now) {
  const expiresAt = budget.expiresAt === undefined ? undefined : Date.parse(budget.expiresAt);
  if (
    typeof budget.maxCostUsd !== 'number' ||
    !Number.isFinite(budget.maxCostUsd) ||
    budget.maxCostUsd <= 0 ||
    (expiresAt !== undefined && !Number.isFinite(expiresAt))
  )
    throw new Error('runtime-permission-or-sandbox-error');
  let cost = 0;
  let stopped;
  const check = (ctx, forced) => {
    const reason =
      stopped ||
      forced ||
      (expiresAt !== undefined && now() >= expiresAt
        ? 'api-budget-expired'
        : cost >= budget.maxCostUsd
          ? 'api-budget-exhausted'
          : undefined);
    if (reason) {
      // Pi catches extension exceptions, so abort the real request signal before returning.
      ctx.abort();
      if (!stopped) ctx.ui.notify(reason, 'error');
      stopped = reason;
    }
    return reason;
  };
  pi.on('message_end', (event, ctx) => {
    if (event.message?.role !== 'assistant') return;
    const observed = event.message.usage?.cost?.total;
    if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0) {
      check(ctx, 'api-budget-usage-unknown');
      return;
    }
    cost += observed;
    check(ctx);
  });
  pi.on('before_provider_request', (_event, ctx) => {
    check(ctx);
    ctx.signal?.throwIfAborted();
  });
  pi.on('tool_call', (_event, ctx) => {
    const reason = check(ctx);
    return reason ? blocked(reason) : undefined;
  });
  pi.registerCommand(budgetCommand, {
    description: 'PugPort host-owned per-run API spending and cutoff guard v1',
    handler: async (_args, ctx) => ctx.ui.notify('PugPort API budget guard ready.', 'info'),
  });
}

/** Register only tools granted by the live host token; no provider credential crosses this bridge. */
export async function registerPiHostBridge(pi, environment, fetchImpl = fetch) {
  const url = new URL(environment.COMBORUNNER_AGENT_BRIDGE_URL);
  const token = environment.COMBORUNNER_AGENT_BRIDGE_TOKEN;
  const expected = JSON.parse(environment.COMBORUNNER_AGENT_BRIDGE_TOOLS || 'null');
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    typeof token !== 'string' ||
    !token ||
    !Array.isArray(expected) ||
    expected.length > 256 ||
    expected.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,119}$/.test(name)) ||
    new Set(expected).size !== expected.length
  )
    throw new Error('runtime-permission-or-sandbox-error');
  const request = async (method, params, signal, timeout) => {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error('PugPort host tool authorization or connection failed.');
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('PugPort host tool response exceeded the protocol limit.');
    const data =
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream'
        ? text
            .split(/\r\n|\r|\n/)
            .filter((line) => line.startsWith('data:'))
            .at(-1)
            ?.slice(5)
        : text;
    const packet = JSON.parse(data ?? '');
    if (packet.error || !packet.result || typeof packet.result !== 'object')
      throw new Error('PugPort host tool request failed.');
    return packet.result;
  };
  const catalogue = await request('tools/list', {}, undefined, 20_000);
  if (!Array.isArray(catalogue.tools) || catalogue.tools.length !== expected.length)
    throw new Error('PugPort host tool catalogue changed.');
  const names = new Set();
  for (const tool of catalogue.tools) {
    if (!expected.includes(tool.name) || names.has(tool.name) || tool.inputSchema?.type !== 'object')
      throw new Error('PugPort host tool catalogue is invalid.');
    const name = `pugport_${tool.name}`;
    names.add(tool.name);
    pi.registerTool({
      name,
      label: `PugPort · ${tool.name}`,
      description: tool.description || `PugPort host tool ${tool.name}`,
      parameters: tool.inputSchema,
      async execute(toolCallId, args, signal, _onUpdate, ctx) {
        const signals = [signal, ctx.signal].filter(Boolean);
        const activeSignal = signals.length ? AbortSignal.any(signals) : undefined;
        const result = await request('tools/call', { name: tool.name, arguments: args }, activeSignal, 660_000);
        const content = Array.isArray(result.content) ? result.content : [];
        if (result.isError === true)
          throw new Error(
            `PugPort host tool failed: ${content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n')
              .slice(0, 20000)}`,
          );
        return {
          content: content.length ? content : [{ type: 'text', text: JSON.stringify(result.structuredContent ?? {}) }],
          details: { source: 'pugport', tool: tool.name, nativeToolCallId: toolCallId },
        };
      },
    });
  }
  pi.registerCommand(hostBridgeCommand, {
    description: 'PugPort run-scoped host tools and delegation bridge v1',
    handler: async (_args, ctx) => ctx.ui.notify('PugPort host tool bridge ready.', 'info'),
  });
  return new Set(expected.map((name) => `pugport_${name}`));
}

// Match Pi's documented file-tool path conventions before explaining the scope.
function resolveToolPath(input, cwd) {
  let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (value.startsWith('@')) value = value.slice(1);
  if (process.platform === 'win32' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
    if (drive) value = `${drive[1].toUpperCase()}:\\${(drive[2] || '').replaceAll('/', '\\')}`;
  }
  if (value === '~') value = homedir();
  else if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\')))
    value = join(homedir(), value.slice(2));
  if (value.startsWith('file://')) value = fileURLToPath(value);
  return resolve(cwd, value);
}

// New files do not have a realpath yet. Resolve their nearest existing parent to detect links.
async function canonicalDestination(path) {
  let current = path;
  const suffix = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code) || dirname(current) === current) throw error;
      suffix.unshift(basename(current));
      current = dirname(current);
    }
  }
}

/** Resolve the actual file scope alongside the approval description; this is not an OS sandbox. */
export async function describePiToolCall(event, cwd) {
  const tool = event.toolName;
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  const call = typeof event.toolCallId === 'string' ? event.toolCallId.slice(0, 200) : 'unknown';
  if (shellTools.has(tool)) {
    if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('Missing shell command');
    if (input.command.length > 12000) throw new Error('Shell command is too long for a complete approval preview');
    return {
      kind: 'shell',
      title: `Pi · ${tool} · 执行命令`,
      message: `工具调用：${call}\n工作目录：${cwd}\n\n将运行以下命令：\n${input.command}\n\nPi 没有操作系统沙箱。此命令可能读写工作区外文件、访问网络或启动其他程序；本次批准只针对这一条工具调用。`,
    };
  }
  if (!fileTools.has(tool)) throw new Error('Tool is not allowed by the PugPort bridge');
  const path = typeof input.path === 'string' ? input.path : ['grep', 'find', 'ls'].includes(tool) ? '.' : undefined;
  if (!path || path.length > 4096 || path.includes('\0')) throw new Error('Invalid file-tool path');
  const [root, destination] = await Promise.all([realpath(cwd), canonicalDestination(resolveToolPath(path, cwd))]);
  const rel = relative(root, destination);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  const mutates = tool === 'write' || tool === 'edit';
  const scope = outside ? '工作区外' : '工作区内';
  let preview = '';
  if (tool === 'write') preview = `\n\n写入内容预览：\n${String(input.content ?? '').slice(0, 10000)}`;
  if (tool === 'edit') {
    // Pi groups changes to one file in edits[]. Never show an empty legacy preview.
    if (!Array.isArray(input.edits) || !input.edits.length) throw new Error('Missing edit operations');
    preview = `\n\n共 ${input.edits.length} 处替换：\n${input.edits
      .map(
        (edit, index) =>
          `第 ${index + 1} 处替换前：\n${String(edit.oldText ?? '')}\n替换后：\n${String(edit.newText ?? '')}`,
      )
      .join('\n\n')
      .slice(0, 10000)}`;
  }
  if (tool === 'grep' || tool === 'find')
    preview = `\n\n检索参数：${JSON.stringify({ pattern: input.pattern, glob: input.glob, limit: input.limit }).slice(0, 3000)}`;
  return {
    kind: 'file',
    outside,
    title: `Pi · ${tool} · ${scope}${mutates ? '写入' : '读取'}`,
    message: `工具调用：${call}\n项目目录：${root}\n请求路径：${path}\n解析目标：${destination}\n范围：${scope}\n${outside ? `本次操作将${mutates ? '修改' : '读取'}所选项目目录之外的内容。` : `本次操作将${mutates ? '修改' : '读取'}项目中的内容。`}${preview}\n\n内容预览可能截断。路径范围仅用于提示，不能替代操作系统沙箱；符号链接和并发文件变化仍由本机文件系统决定。本次批准只针对这一条工具调用。`,
  };
}

export default function studioPermissions(pi) {
  // Set by PugPort before spawning Pi. Never take this policy from a model/tool argument.
  const approvalMode = process.env.COMBORUNNER_TOOL_APPROVAL_MODE === 'auto' ? 'auto' : 'ask';
  const readOnly = process.env.COMBORUNNER_PI_PERMISSION_MODE === 'read-only';
  const prohibitCommands = process.env.COMBORUNNER_PI_PROHIBIT_COMMANDS === '1';
  // A trusted project's writable turn runs commands like Codex and Claude do there (decided by PugPort, never a tool).
  const trustedCommands = process.env.COMBORUNNER_PI_TRUSTED_COMMANDS === '1';
  const codemode = process.env.COMBORUNNER_PI_CODEMODE === 'on';
  if (process.env.COMBORUNNER_PI_API_BUDGET)
    registerPiBudgetGuard(pi, JSON.parse(process.env.COMBORUNNER_PI_API_BUDGET));
  let hostTools = new Set();
  pi.on('tool_call', async (event, ctx) => {
    if (ctx.signal?.aborted) return blocked('PugPort cancelled this tool call.');
    if (prohibitCommands && shellTools.has(event.toolName))
      return blocked('The user prohibited commands for this run.');
    // Only the orchestration is allowed here. Pi sends every nested call back through these hooks.
    if (codemode && event.toolName === 'codemode') return undefined;
    // Authorization and operation scope are enforced again by the same host AgentBridge.
    if (hostTools.has(event.toolName)) return undefined;
    if (readOnly) {
      if (['read', 'grep', 'find', 'ls'].includes(event.toolName)) return undefined;
      return blocked('PugPort read-only mode does not authorize this tool.');
    }
    if (approvalMode === 'ask' && !ctx.hasUI)
      return blocked('PugPort approval bridge is unavailable; this tool was not executed.');
    try {
      if (approvalMode === 'auto' && shellTools.has(event.toolName) && trustedCommands) {
        await describePiToolCall(event, ctx.cwd);
        if (ctx.signal?.aborted) return blocked('PugPort cancelled this tool call.');
        event.input.command = commandForTrustedTurn(event.toolName, event.input.command);
        return undefined;
      }
      if (approvalMode === 'auto' && shellTools.has(event.toolName)) {
        ctx.ui.notify?.(`pugport-command-untrusted:${event.toolCallId}`, 'info');
        return blocked(
          'PugPort 自动模式不执行 Pi shell 命令：Pi 没有操作系统沙箱。请使用 Codex 原生执行器完成需要 shell 的任务；本次命令未执行。',
        );
      }
      const request = await describePiToolCall(event, ctx.cwd);
      if (ctx.signal?.aborted) return blocked('PugPort cancelled this tool call.');
      if (approvalMode === 'auto') {
        if (request.kind !== 'file' || request.outside)
          return blocked(
            'PugPort 自动模式仅允许所选工作区内的文件工具；当前路径解析到了工作区之外，本次操作未执行。请在所选项目内完成任务。',
          );
        return undefined;
      }
      const allowed = await ctx.ui.confirm(request.title, request.message, { signal: ctx.signal, timeout: 600_000 });
      if (!allowed || ctx.signal?.aborted) return blocked('PugPort denied or cancelled this tool call.');
      return undefined;
    } catch {
      return blocked(
        approvalMode === 'auto'
          ? 'PugPort 自动模式无法验证此工具或路径；只支持所选工作区内的 read、grep、find、ls、edit、write，本次操作未执行。需要 shell 时请使用 Codex 原生执行器。'
          : 'PugPort could not validate or approve this tool call; it was not executed.',
      );
    }
  });

  // Discovery checks this marker before enabling any model work. The optional probe exercises
  // RPC confirmation without prompting a model, reading project files, or changing them.
  pi.registerCommand(permissionCommand, {
    description: 'PugPort scoped file automation and per-call permission bridge v1',
    handler: async (args, ctx) => {
      if (args.trim() !== 'probe') {
        ctx.ui.notify('PugPort permission bridge ready.', 'info');
        return;
      }
      const allowed = await ctx.ui.confirm(
        'PugPort permission bridge probe',
        '无模型验证：确认这一项不会读取或修改项目文件。',
        { signal: ctx.signal, timeout: 5000 },
      );
      ctx.ui.notify(allowed ? 'studio-permissions-probe:approved' : 'studio-permissions-probe:denied', 'info');
    },
  });
  const registrations = [];
  if (codemode) registrations.push(registerPiCodemode(pi));
  if (process.env.COMBORUNNER_AGENT_BRIDGE_URL || process.env.COMBORUNNER_AGENT_BRIDGE_TOKEN)
    registrations.push(
      registerPiHostBridge(pi, { ...process.env }).then((names) => {
        hostTools = names;
      }),
    );
  if (registrations.length) return Promise.all(registrations).then(() => undefined);
}
