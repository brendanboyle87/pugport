import { execFile } from './platform/test-process.ts';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  SyntaxKind,
  type ParseError,
} from 'jsonc-parser';
import type { Provider, RuntimeTarget } from '../shared/types.ts';
import { windowsWrapperCommand } from './adapters/process.ts';
import { parseCodexMcp } from './extensions.ts';
import { cliEnvironment, findExecutable } from './platform/executables.ts';
import { currentHost, type Host } from './platform/host.ts';

/*
 * One-click connection of other AI tools on this computer to the pugport MCP server (src/mcp/pugport-mcp.ts). A
 * JSON tools get local JSONC edits; TOML tools use their own `mcp add` command, run as PugPort runs that tool.
 * The entry only says how to start the server: no token or key, since the
 * server asks the running PugPort for a session each time. Every change keeps a backup next to the file.
 */

export type McpCommand = { command: string; args: string[]; env?: Record<string, string> };
export const connectToolIds = ['claude', 'codex', 'cursor', 'grok'] as const;
export type ConnectToolId = (typeof connectToolIds)[number];
export type ConnectToolView = {
  id: ConnectToolId;
  name: string;
  /** Its command, its settings folder or its config file is on this computer. */
  detected: boolean;
  /** outdated: an entry of ours points somewhere else (PugPort moved), or an old one is in the way. */
  state: 'connected' | 'outdated' | 'absent';
  disabled?: true;
  /** command: PugPort runs the TOML tool's `mcp add`; file: PugPort edits JSONC; copy: only by hand. */
  method: 'command' | 'file' | 'copy';
  configPath: string;
  /** The name PugPort has in that tool. */
  server: string;
  /** The command line to run by hand, or (Cursor) the entry to paste into its config file. */
  manual: string;
  note?: string;
};
export type ConnectResult = {
  tool: ConnectToolView;
  changed: boolean;
  configPath: string;
  /** The entry as it now reads in the tool's config (connect), or as it read before (remove). */
  entry?: string;
  backup?: string;
};

/**
 * The name other tools know PugPort by. Not "pugport": that is the name of the built-in tool bridge PugPort hands
 * its own runs of these same tools (Codex: `-c mcp_servers.pugport.url=…`; Claude: --mcp-config; Grok and Cursor:
 * the session's servers), and an entry of that name in the tool's own config collides with it. Codex then refuses
 * to start at all ("url is not supported for stdio"); the others may let the entry hide the bridge.
 */
export const serverName = 'pugport-app';
/** The name an older PugPort suggested; such an entry (only one starting this server) is replaced on connecting. */
const legacyName = 'pugport';
/** The only settings the entry may carry; anything else (a token) is refused before a file is touched. */
const allowedEnv = new Set(['ELECTRON_RUN_AS_NODE', 'PUGPORT_PORT', 'PUGPORT_CALLER']);

type Entry = { command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean };
type Spec = {
  name: string;
  /** The tool's own command; none means its config file is edited instead. */
  binary?: string;
  /** PugPort's executor card for the tool: its command is the CLI as PugPort runs it (and the config it reads). */
  provider?: Provider;
  config: (host: Host) => string;
  /** The tool's settings folder: installed even when its command is not on PATH. */
  folder: (host: Host) => string;
  format: 'json' | 'toml';
  add?: (name: string, mcp: McpCommand) => string[];
  remove?: (name: string) => string[];
  note?: string;
};

const pairs = (mcp: McpCommand) =>
  Object.entries(mcp.env ?? {})
    .filter(([key]) => allowedEnv.has(key))
    .map(([key, value]) => `${key}=${value}`);
const forCaller = (mcp: McpCommand, id: ConnectToolId): McpCommand => ({
  ...mcp,
  env: { ...mcp.env, PUGPORT_CALLER: id },
});
export const codexHome = (host: Pick<Host, 'env' | 'path' | 'home'>) =>
  host.env.CODEX_HOME && host.path.isAbsolute(host.env.CODEX_HOME)
    ? host.env.CODEX_HOME
    : host.path.join(host.home, '.codex');

export const claudeConfigFile = (host: Pick<Host, 'env' | 'path' | 'home'>) =>
  host.path.join(
    host.env.CLAUDE_CONFIG_DIR && host.path.isAbsolute(host.env.CLAUDE_CONFIG_DIR)
      ? host.env.CLAUDE_CONFIG_DIR
      : host.home,
    '.claude.json',
  );

// Each command line follows that tool's own `mcp add --help`.
const specs: Record<ConnectToolId, Spec> = {
  claude: {
    name: 'Claude Code',
    binary: 'claude',
    provider: 'claude',
    // CLAUDE_CONFIG_DIR moves the whole configuration, the user's MCP servers included.
    config: claudeConfigFile,
    folder: (host) => host.path.join(host.home, '.claude'),
    format: 'json',
    // claude mcp add [options] <name> <commandOrUrl> [args...]: -e takes several values, so "--" ends them.
    add: (name, mcp) => [
      'mcp',
      'add',
      name,
      '--scope',
      'user',
      ...pairs(mcp).flatMap((pair) => ['-e', pair]),
      '--',
      mcp.command,
      ...mcp.args,
    ],
    remove: (name) => ['mcp', 'remove', name, '--scope', 'user'],
  },
  codex: {
    name: 'Codex',
    binary: 'codex',
    provider: 'codex',
    config: (host) => host.path.join(codexHome(host), 'config.toml'),
    folder: codexHome,
    format: 'toml',
    // codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)
    add: (name, mcp) => [
      'mcp',
      'add',
      name,
      ...pairs(mcp).flatMap((pair) => ['--env', pair]),
      '--',
      mcp.command,
      ...mcp.args,
    ],
    remove: (name) => ['mcp', 'remove', name],
  },
  cursor: {
    name: 'Cursor',
    config: (host) => host.path.join(host.home, '.cursor', 'mcp.json'),
    folder: (host) => host.path.join(host.home, '.cursor'),
    format: 'json',
    note: 'Cursor 会要你批准新加的工具：接入后在 Cursor 的 MCP 设置里打开 pugport-app。',
  },
  grok: {
    name: 'Grok CLI',
    binary: 'grok',
    provider: 'grok',
    config: (host) => host.path.join(host.home, '.grok', 'config.toml'),
    folder: (host) => host.path.join(host.home, '.grok'),
    format: 'toml',
    // grok mcp add [OPTIONS] <NAME> [COMMAND_OR_URL] [ARGS]...: everything after -- is the server command.
    add: (name, mcp) => [
      'mcp',
      'add',
      '--scope',
      'user',
      name,
      ...pairs(mcp).flatMap((pair) => ['-e', pair]),
      '--',
      mcp.command,
      ...mcp.args,
    ],
    remove: (name) => ['mcp', 'remove', '--scope', 'user', name],
  },
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const jsonOptions = { allowTrailingComma: true };
function configJson(text: string, path: string) {
  const errors: ParseError[] = [];
  const root = parse(text.replace(/^\uFEFF/, ' '), errors, jsonOptions);
  if (errors.length) throw new Error(`${path} 里有注释或不是标准 JSON，PugPort 不改它，以免弄坏；请复制配置手动加入。`);
  if (!record(root)) throw new Error(`${path} 的内容不是 JSON 对象，PugPort 不改它。`);
  if (root.mcpServers !== undefined && !record(root.mcpServers))
    throw new Error(`${path} 里的 mcpServers 不是对象，PugPort 不改它。`);
  return root as Record<string, unknown>;
}

function editServer(text: string, value: unknown) {
  const path = ['mcpServers', serverName];
  const edits = modify(text, path, value, {});
  if (value !== undefined || !edits.length) return applyEdits(text, edits);
  const property = findNodeAtLocation(parseTree(text, [], jsonOptions)!, path)!.parent!;
  const end = property.offset + property.length;
  const edit = edits[0]!;
  // modify's deletion spans adjacent trivia. Keep it, and remove only the property and one separator.
  const scanner = createScanner(text, true);
  scanner.setPosition(edit.offset);
  let comma: number | undefined;
  while (scanner.scan() !== SyntaxKind.EOF && scanner.getTokenOffset() < edit.offset + edit.length)
    if (
      scanner.getToken() === SyntaxKind.CommaToken &&
      (scanner.getTokenOffset() < property.offset || scanner.getTokenOffset() >= end)
    )
      comma = scanner.getTokenOffset();
  const kept = text.slice(edit.offset, property.offset) + text.slice(end, edit.offset + edit.length);
  const commaIndex = comma === undefined ? undefined : comma - edit.offset - (comma >= end ? property.length : 0);
  edit.content = commaIndex === undefined ? kept : kept.slice(0, commaIndex) + kept.slice(commaIndex + 1);
  if (comma === undefined) {
    scanner.setPosition(end);
    if (scanner.scan() === SyntaxKind.CommaToken)
      edits.push({ offset: scanner.getTokenOffset(), length: 1, content: '' });
  }
  return applyEdits(text, edits);
}
const entryOf = (mcp: McpCommand) => ({ command: mcp.command, args: mcp.args, ...(mcp.env ? { env: mcp.env } : {}) });
const same = (entry: Entry, mcp: McpCommand) =>
  entry.command === mcp.command &&
  JSON.stringify(entry.args ?? []) === JSON.stringify(mcp.args) &&
  [...allowedEnv].every((key) => entry.env?.[key] === mcp.env?.[key]);
/** An entry that starts this very server: the only kind ever removed under the legacy name. */
const ownScript = (entry: Entry | undefined) => !!entry?.args?.some((arg) => /pugport-mcp\.js$/i.test(arg));
// PowerShell drops a bare -- before npm's .ps1 launchers; cmd and POSIX shells pass the quoted form on unchanged.
const quoted = (value: string) => (value === '--' ? '"--"' : /^[\w\-.:\\/=@]+$/.test(value) ? value : `"${value}"`);
/** What a generic MCP client (anything not listed) needs; also what Cursor's file gets. */
export const mcpConfigSnippet = (mcp: McpCommand, name = serverName) =>
  JSON.stringify({ mcpServers: { [name]: entryOf(mcp) } }, null, 2);

/** The default card of a provider (not an isolated account, whose CLI reads its own configuration). */
function defaultCard(cards: RuntimeTarget[], provider: Provider) {
  const plain = (card: RuntimeTarget) =>
    card.provider === provider &&
    card.environment === 'native' &&
    !card.gateway &&
    !card.accountId &&
    !card.args?.length;
  return cards.find((card) => card.id === `${provider}-native` && plain(card)) ?? cards.find(plain);
}

export type McpConnectOptions = {
  /** How the pugport MCP server starts on this machine (external-tasks.ts mcpCommand). */
  command: () => McpCommand;
  /** PugPort's executor cards. */
  cards?: () => RuntimeTarget[];
  host?: Host;
  now?: () => Date;
  timeoutMs?: number;
};

export class McpConnections {
  private changing = false;
  constructor(private readonly options: McpConnectOptions) {}
  private get host() {
    return this.options.host ?? currentHost();
  }

  list() {
    const mcp = this.options.command();
    return {
      server: serverName,
      tools: connectToolIds.map((id) => this.inspect(id, mcp).view),
      snippet: mcpConfigSnippet(mcp),
    };
  }

  async connect(id: ConnectToolId): Promise<ConnectResult> {
    return this.exclusive(async () => {
      const mcp = forCaller(this.checked(), id);
      const spec = specs[id];
      const before = this.inspect(id, mcp);
      const { view } = before;
      if (!view.detected) throw new Error(`没有在这台电脑上找到 ${spec.name}。`);
      if (view.state === 'connected')
        return {
          tool: view,
          changed: false,
          configPath: view.configPath,
          entry: this.entryText(spec, view.configPath),
        };
      if (view.method === 'copy') throw new Error(view.note ?? `请复制命令，手动接入 ${spec.name}。`);
      const backup =
        view.method === 'file' ? this.editJson(view.configPath, entryOf(mcp)) : this.backup(view.configPath);
      if (view.method === 'command') {
        // An entry of ours that points elsewhere goes first: `claude mcp add` refuses a name that is taken.
        if (before.entry) await this.run(spec, before.cli!, spec.remove!(serverName));
        if (before.legacy) await this.run(spec, before.cli!, spec.remove!(legacyName));
        await this.run(spec, before.cli!, spec.add!(serverName, mcp));
      }
      const after = this.inspect(id, mcp).view;
      if (after.state !== 'connected')
        throw new Error(
          `${spec.name} 的命令已运行，但 ${after.configPath} 里没有出现 ${serverName}。这个 ${spec.binary} 可能用的是别处的配置（例如 WSL 里的）；可以复制命令，在它的终端里运行。`,
        );
      return {
        tool: after,
        changed: true,
        configPath: after.configPath,
        entry: this.entryText(spec, after.configPath),
        ...(backup ? { backup } : {}),
      };
    });
  }

  async remove(id: ConnectToolId): Promise<ConnectResult> {
    return this.exclusive(async () => {
      const mcp = this.options.command();
      const spec = specs[id];
      const before = this.inspect(id, mcp);
      const { view } = before;
      if (spec.format === 'json' && before.unreadable)
        configJson(this.host.fs.readFileSync(view.configPath, 'utf8'), view.configPath);
      if (!before.entry && !before.legacy) return { tool: view, changed: false, configPath: view.configPath };
      if (view.method === 'copy')
        throw new Error(
          view.note ?? `PugPort 不能替你改 ${spec.name} 的配置，请在 ${view.configPath} 里删掉 ${serverName}。`,
        );
      const entry = this.entryText(spec, view.configPath, before.entry ? serverName : legacyName);
      const backup = view.method === 'file' ? this.editJson(view.configPath, undefined) : this.backup(view.configPath);
      if (view.method === 'command') {
        if (before.entry) await this.run(spec, before.cli!, spec.remove!(serverName));
        if (before.legacy) await this.run(spec, before.cli!, spec.remove!(legacyName));
      }
      const after = this.inspect(id, mcp);
      if (after.entry || after.legacy)
        throw new Error(`${spec.name} 的命令已运行，但 ${after.view.configPath} 里还有 ${serverName}。`);
      return {
        tool: after.view,
        changed: true,
        configPath: after.view.configPath,
        ...(entry ? { entry } : {}),
        ...(backup ? { backup } : {}),
      };
    });
  }

  private async exclusive<T>(work: () => Promise<T>) {
    if (this.changing) throw new Error('上一个接入操作还没完成，请稍候再试。');
    this.changing = true;
    try {
      return await work();
    } finally {
      this.changing = false;
    }
  }

  private checked() {
    const mcp = this.options.command();
    for (const key of Object.keys(mcp.env ?? {}))
      if (!allowedEnv.has(key)) throw new Error(`pugport 的启动设置里有不该写进其他工具的环境变量 ${key}，已停止。`);
    const script = mcp.args.at(-1);
    if (!script || !this.host.fs.existsSync(script))
      throw new Error('还没有构建 pugport MCP 服务（dist/server/pugport-mcp.js），请先构建 PugPort。');
    return mcp;
  }

  /** The tool's own command: the one PugPort's card for it runs, else the first on PATH. */
  private cli(spec: Spec) {
    if (!spec.binary) return undefined;
    const card = spec.provider ? defaultCard(this.options.cards?.() ?? [], spec.provider) : undefined;
    const host = this.host;
    if (card && host.path.isAbsolute(card.command) && this.isFile(card.command)) return card.command;
    return findExecutable(spec.binary, host);
  }

  private isFile(path: string) {
    try {
      return this.host.fs.statSync(path).isFile();
    } catch {
      return false;
    }
  }

  /** Started without a shell: Windows runs .exe directly and .cmd/.bat through cmd.exe; .ps1 cannot be. */
  private runnable(command: string) {
    return this.host.platform !== 'win32' || /\.(?:exe|cmd|bat)$/i.test(command);
  }

  private read(spec: Spec, path: string): { servers: Map<string, Entry>; unreadable?: boolean } {
    let text: string;
    try {
      text = this.host.fs.readFileSync(path, 'utf8');
    } catch {
      return { servers: new Map() };
    }
    try {
      if (spec.format === 'toml')
        return {
          servers: new Map(parseCodexMcp(text, { includeDisabled: true }).map((draft) => [draft.name, draft as Entry])),
        };
      const servers = record(configJson(text, path).mcpServers) ?? {};
      return {
        servers: new Map(Object.entries(servers).map(([name, value]) => [name, (record(value) ?? {}) as Entry])),
      };
    } catch {
      return { servers: new Map(), unreadable: true };
    }
  }

  private inspect(id: ConnectToolId, mcp: McpCommand) {
    mcp = forCaller(mcp, id);
    const host = this.host;
    const spec = specs[id];
    const configPath = spec.config(host);
    const cli = this.cli(spec);
    const detected =
      !!cli ||
      host.fs.existsSync(spec.folder(host)) ||
      host.fs.existsSync(configPath) ||
      (id === 'cursor' && !!findExecutable('cursor-agent', host));
    const { servers, unreadable } = this.read(spec, configPath);
    const entry = servers.get(serverName);
    const legacy = spec.format === 'toml' && ownScript(servers.get(legacyName));
    const disabled = entry ? entry.enabled === false : legacy && servers.get(legacyName)?.enabled === false;
    const method: ConnectToolView['method'] = !detected
      ? 'copy'
      : spec.format === 'json'
        ? 'file'
        : spec.binary
          ? cli && this.runnable(cli)
            ? 'command'
            : 'copy'
          : 'file';
    const note = !detected
      ? `没有在这台电脑上找到 ${spec.name}。`
      : unreadable
        ? `${configPath} 读不出来（可能格式有问题），接入状态未知。`
        : spec.format === 'toml' && spec.binary && !cli
          ? `找到了 ${spec.name} 的设置，但没找到 ${spec.binary} 命令；可以复制命令，在装了它的终端里运行。`
          : spec.format === 'toml' && spec.binary && method === 'copy'
            ? `${cli} 不能直接运行（例如 PowerShell 脚本）；请复制命令到终端里运行。`
            : legacy
              ? `配置里有旧的 pugport 条目，和 PugPort 给自己执行器的内置工具同名，可能让 PugPort 调用 ${spec.name} 时出错；点「更新」换成 ${serverName}。`
              : spec.note;
    const view: ConnectToolView = {
      id,
      name: spec.name,
      detected,
      state: entry && same(entry, mcp) && !legacy && !disabled ? 'connected' : entry || legacy ? 'outdated' : 'absent',
      ...(disabled ? { disabled: true } : {}),
      method,
      configPath,
      server: serverName,
      manual: spec.add ? [spec.binary!, ...spec.add(serverName, mcp)].map(quoted).join(' ') : mcpConfigSnippet(mcp),
      ...(note ? { note } : {}),
    };
    return { view, entry, legacy, cli, unreadable };
  }

  /** The entry as the tool's file holds it: its TOML table, or its JSON object. */
  private entryText(spec: Spec, path: string, name = serverName) {
    let text: string;
    try {
      text = this.host.fs.readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
    if (spec.format === 'json') {
      const entry = this.read(spec, path).servers.get(name);
      return entry ? JSON.stringify({ [name]: entry }, null, 2) : undefined;
    }
    const lines: string[] = [];
    let inside = false;
    for (const line of text.split(/\r?\n/)) {
      const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
      if (header) {
        const key = /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))(?:\.|$)/.exec(header[1]!);
        inside = !!key && (key[1] ?? key[2] ?? key[3]) === name;
      }
      if (inside) lines.push(line);
    }
    return lines.join('\n').trim() || undefined;
  }

  private backup(path: string) {
    const { fs } = this.host;
    if (!fs.existsSync(path)) return undefined;
    const stamp = (this.options.now?.() ?? new Date())
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    let target = `${path}.pugport-backup-${stamp}`;
    for (let index = 2; fs.existsSync(target); index++) target = `${path}.pugport-backup-${stamp}-${index}`;
    fs.copyFileSync(path, target, fs.constants.COPYFILE_EXCL);
    return target;
  }

  /** JSONC edits preserve unrelated bytes; backup only after the file is known to be safe to change. */
  private editJson(path: string, value: unknown) {
    const { fs } = this.host;
    const before = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
    if (before !== undefined) configJson(before, path);
    const text = before ?? '{}\n';
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const after = bom + editServer(text.slice(bom.length), value);
    const backup = this.backup(path);
    this.writeAtomically(path, after, before);
    return backup;
  }

  /** A temporary file beside it, then a rename: the tool never reads half a file. */
  private writeAtomically(path: string, text: string, expected: string | undefined) {
    const { fs, path: paths } = this.host;
    const folder = paths.dirname(path);
    fs.mkdirSync(folder, { recursive: true });
    const mode = expected === undefined ? 0o600 : fs.statSync(path).mode & 0o777;
    const temporary = paths.join(folder, `.pugport-${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
    try {
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const now = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
      if (now !== expected) throw new Error(`${path} 在这期间被别的程序改过，PugPort 没有写入；请重试。`);
      fs.renameSync(temporary, path);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  private run(spec: Spec, command: string, args: string[]) {
    const host = this.host;
    const wrapper = host.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
    let line = '';
    if (wrapper)
      try {
        line = windowsWrapperCommand(command, args);
      } catch {
        throw new Error('路径里有命令行不能安全传递的字符（例如 % 或 !）；请复制命令，在终端里运行。');
      }
    const env = { ...host.env };
    // The desktop backend runs as Node inside PugPort's own executable; the tool's CLI must not inherit that.
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise<void>((resolve, reject) => {
      execFile(
        wrapper ? host.path.join(host.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : command,
        wrapper ? ['/d', '/s', '/c', line] : args,
        {
          cwd: host.home,
          env: cliEnvironment(command, env, host),
          timeout: this.options.timeoutMs ?? 60_000,
          windowsHide: true,
          windowsVerbatimArguments: wrapper,
          encoding: 'utf8',
          maxBuffer: 1 << 20,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve();
          const said = `${stderr || stdout}`.replace(/\s+/g, ' ').trim().slice(0, 300);
          reject(new Error(`${spec.name} 的命令没有成功${said ? `：${said}` : '。'}`));
        },
      );
    });
  }
}

export function mcpConnectRoutes(app: Express, connections: McpConnections) {
  const tool = (value: string) => z.enum(connectToolIds).parse(value);
  app.get('/api/external/connections', (_req, res) => res.json(connections.list()));
  app.post('/api/external/connections/:tool', async (req, res) => {
    res.json(await connections.connect(tool(req.params.tool)));
  });
  app.delete('/api/external/connections/:tool', async (req, res) => {
    res.json(await connections.remove(tool(req.params.tool)));
  });
}
