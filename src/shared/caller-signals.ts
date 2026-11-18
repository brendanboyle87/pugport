/** Only permission-related signals cross this boundary. No IO or platform dependencies. */
export type CallerClient = 'claude' | 'codex' | 'gemini' | 'grok' | 'cursor' | 'unknown' | 'terminal';
export type CallerContext = {
  client: CallerClient;
  version?: string;
  mode: 'write' | 'read-only' | 'write-anywhere' | 'unknown';
  /** Whether this caller itself may use the network, as far as its own sandbox settings show. */
  network?: boolean;
  roots: string[];
  cwd?: string;
  evidence: string[];
  verified: boolean;
};
export type CallerProbeInput = {
  chain: { exe: string; args: string[] }[];
  envNames: string[];
  timedOut?: boolean;
  clientInfo?: { name: string; version: string };
  cwd?: string;
  pugportCaller?: string;
  clientRoots?: string[];
  config?: { codexToml?: string; claudeSettings?: string[]; grokToml?: string };
};

function identity(name: string): CallerClient {
  if (/claude(?:-code)?/i.test(name)) return 'claude';
  if (/codex/i.test(name)) return 'codex';
  if (/gemini/i.test(name)) return 'gemini';
  if (/grok/i.test(name)) return 'grok';
  if (/cursor(?:-agent)?/i.test(name)) return 'cursor';
  return 'unknown';
}

function executable(exe: string, args: string[]): CallerClient {
  const base = exe
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)!
    .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  if (/^(claude(?:-code)?|codex|gemini|grok|cursor(?:-agent)?)$/i.test(base)) return identity(base);
  // npm CLIs often run as `node /.../@vendor/tool/cli.js`. Never inspect prompts as identities.
  if (/^(node|nodejs|bun)$/i.test(base)) {
    const script = args[0]?.replace(/\\/g, '/') ?? '';
    if (/\/(?:@anthropic-ai\/claude-code|@openai\/codex|@google\/gemini-cli|grok-cli|cursor-agent)\//i.test(script))
      return identity(script);
    if (/^(?:.*\/)?(?:claude|codex|gemini|grok|cursor-agent)\.(?:m?js|cjs)$/i.test(script)) return identity(script);
  }
  return 'unknown';
}

/** Lexical normalization, including WSL drive mounts; never touches the filesystem. */
function normalize(path: string, cwd?: string): string {
  let value = path
    .replace(/\\/g, '/')
    .replace(/^\/mnt\/([a-z])(?=\/|$)/i, (_, drive: string) => `${drive.toUpperCase()}:`);
  if (!/^(?:[a-z]:\/|\/)/i.test(value) && cwd) value = `${cwd.replace(/\\/g, '/')}/${value}`;
  const drive = /^[a-z]:/i.exec(value)?.[0].toUpperCase();
  const absolute = !!drive || value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.slice(drive ? 2 : 0).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  return drive ? `${drive}\\${parts.join('\\')}` : `${absolute ? '/' : ''}${parts.join('/')}`;
}

function systemDirectory(cwd: string): boolean {
  const path = normalize(cwd).replace(/\\/g, '/');
  return /^(?:[a-z]:\/(?:windows|winnt|program files(?: \(x86\))?)(?:\/|$)|[a-z]:\/users\/[^/]+$|\/(?:home|Users)\/[^/]+$|\/root$|[a-z]:\/$|\/$)/i.test(
    path,
  );
}

/** Too broad to grant as a root: system folders, a home directory, or the folder holding all of them. */
export function broadDirectory(path: string): boolean {
  return systemDirectory(path) || /^(?:[a-z]:\/users|\/home|\/users)$/i.test(normalize(path).replace(/\\/g, '/'));
}

const pathKey = (path: string) => (/^[a-z]:/i.test(path) ? path.toLowerCase() : path);

function values(args: string[], names: string[], multiple = false): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i];
    const name = names.find((key) => arg === key || arg.startsWith(`${key}=`));
    if (!name) continue;
    if (arg.startsWith(`${name}=`)) found.push(arg.slice(name.length + 1));
    else if (args[i + 1] && !args[i + 1].startsWith('-')) {
      found.push(args[++i]);
      if (multiple) while (args[i + 1] && !args[i + 1].startsWith('-')) found.push(args[++i]);
    }
  }
  return found;
}
const has = (args: string[], ...flags: string[]) =>
  args.slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--')).some((arg) => flags.includes(arg));

function scalar(raw: string): string | boolean | undefined {
  const value = raw.trim();
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value) as string;
    } catch {
      /* unsupported TOML escape */
    }
  }
  return undefined;
}

/** A deliberately narrow TOML line scan. Ignore tables and keys outside this allowlist. */
function toml(text = '', profile?: string) {
  const result: {
    sandbox?: string;
    roots: string[];
    trusted: string[];
    mode?: string;
    yolo?: boolean;
    network?: boolean;
  } = {
    roots: [],
    trusted: [],
  };
  let table = '';
  let profileSandbox: string | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Strip comments only outside quoted strings.
    const line = lines[i]
      .replace(/("(?:[^"\\]|\\.)*"|'[^']*')|#.*$/g, (match, quoted: string | undefined) => quoted ?? '')
      .trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const dottedTrust = !table && /^projects\.("(?:[^"\\]|\\.)*"|'[^']*')\.trust_level\s*=\s*(.*)$/.exec(line);
    if (dottedTrust && scalar(dottedTrust[2]) === 'trusted') {
      const path = scalar(dottedTrust[1]);
      if (typeof path === 'string') result.trusted.push(normalize(path));
      continue;
    }
    const pair = /^(sandbox_mode|writable_roots|trust_level|permission_mode|yolo|network_access)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!pair) continue;
    const [, key, raw] = pair;
    const value = scalar(raw);
    if (!table && key === 'sandbox_mode' && typeof value === 'string') result.sandbox = value;
    if (profile && key === 'sandbox_mode' && typeof value === 'string') {
      const selected = /^profiles\.(.+)$/.exec(table)?.[1];
      if (selected && (scalar(selected) ?? selected) === profile) profileSandbox = value;
    }
    if (!table && key === 'permission_mode' && typeof value === 'string') result.mode = value;
    if (!table && key === 'yolo' && typeof value === 'boolean') result.yolo = value;
    if (table === 'sandbox_workspace_write' && key === 'network_access' && typeof value === 'boolean')
      result.network = value;
    if (table === 'sandbox_workspace_write' && key === 'writable_roots') {
      let array = raw;
      while (array.trim().startsWith('[') && !array.trimEnd().endsWith(']') && i + 1 < lines.length)
        array += lines[++i].replace(
          /("(?:[^"\\]|\\.)*"|'[^']*')|#.*$/g,
          (match, quoted: string | undefined) => quoted ?? '',
        );
      if (
        /^\s*\[\s*(?:(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:,\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*)*,?\s*)?\]\s*$/.test(array)
      )
        result.roots.push(
          ...Array.from(array.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g), (match) => scalar(match[0])).filter(
            (item): item is string => typeof item === 'string',
          ),
        );
    }
    const project = /^projects\.("(?:[^"\\]|\\.)*"|'[^']*')$/.exec(table);
    if (project && key === 'trust_level' && value === 'trusted') {
      const path = scalar(project[1]);
      if (typeof path === 'string') result.trusted.push(normalize(path));
    }
  }
  if (profileSandbox) result.sandbox = profileSandbox;
  return result;
}

function codexSandbox(args: string[]): string[] {
  const overrides = values(args, ['-c', '--config']).flatMap((value) => {
    const match = /^sandbox_mode\s*=\s*(.*)$/.exec(value);
    return match ? [String(scalar(match[1]) ?? match[1].trim())] : [];
  });
  return [...overrides, ...values(args, ['-s', '--sandbox'])];
}

/** The last `-c sandbox_workspace_write.network_access=` on the command line, if any. */
function codexNetwork(args: string[]): boolean | undefined {
  const overrides = values(args, ['-c', '--config']).flatMap((value) => {
    const match = /^sandbox_workspace_write\.network_access\s*=\s*(.*)$/.exec(value);
    const parsed = match ? scalar(match[1]) : undefined;
    return typeof parsed === 'boolean' ? [parsed] : [];
  });
  return overrides.at(-1);
}

function claudeSettings(text: string): { mode?: string; roots: string[] } {
  try {
    const permissions = JSON.parse(text)?.permissions;
    return {
      mode: typeof permissions?.defaultMode === 'string' ? permissions.defaultMode : undefined,
      roots: Array.isArray(permissions?.additionalDirectories)
        ? permissions.additionalDirectories.filter((item: unknown): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return { roots: [] };
  }
}

export function inferCaller(input: CallerProbeInput): CallerContext {
  const evidence: string[] = [];
  const chain = input.chain.map((entry) => ({ ...entry, client: executable(entry.exe, entry.args) }));
  const observed = chain.filter((entry) => entry.client !== 'unknown');
  const hint = identity(input.pugportCaller ?? '');
  const info = identity(input.clientInfo?.name ?? '');
  const client = hint !== 'unknown' ? hint : (observed[0]?.client ?? info);
  const conflict = [hint, info, ...observed.map((entry) => entry.client)].some(
    (item) => item !== 'unknown' && item !== client,
  );
  if (hint !== 'unknown') evidence.push('identity: PUGPORT_CALLER');
  if (observed.length) evidence.push('identity: process chain');
  if (info !== 'unknown') evidence.push('identity: clientInfo');
  // Each process has its own end-of-options marker; one must not hide another's read-only flag.
  const argumentLists = observed
    .filter((entry) => entry.client === client)
    .map((entry) => entry.args.slice(0, entry.args.indexOf('--') < 0 ? undefined : entry.args.indexOf('--')));
  const args = argumentLists.flat();
  const override = client === 'codex' ? values(args, ['-C', '--cd']).at(-1) : undefined;
  const cwd = override ? normalize(override, input.cwd) : input.cwd ? normalize(input.cwd) : undefined;
  const roots = cwd ? [cwd] : [];
  let mode: CallerContext['mode'] = client === 'unknown' ? 'unknown' : client === 'codex' ? 'read-only' : 'write';
  let readonly = false;
  let codexWorkspaceNetwork: boolean | undefined;
  if (client === 'claude') {
    const settings = (input.config?.claudeSettings ?? []).map(claudeSettings);
    const flags = values(args, ['--permission-mode']);
    const configured = settings.map((setting) => setting.mode).filter((item): item is string => !!item);
    readonly = [...flags, ...configured].includes('plan');
    if (has(args, '--dangerously-skip-permissions') || (flags.at(-1) ?? configured.at(-1)) === 'bypassPermissions')
      mode = 'write-anywhere';
    roots.push(...values(args, ['--add-dir'], true), ...settings.flatMap((setting) => setting.roots));
    if (configured.length) evidence.push('config: permissions.defaultMode');
  } else if (client === 'codex') {
    const configs = argumentLists.map((argv) =>
      toml(input.config?.codexToml, values(argv, ['-p', '--profile']).at(-1)),
    );
    const config = configs.at(-1) ?? toml(input.config?.codexToml);
    const flags = codexSandbox(args);
    codexWorkspaceNetwork = codexNetwork(args) ?? config.network;
    const full = has(args, '--full-auto');
    const bypass = has(args, '--dangerously-bypass-approvals-and-sandbox');
    // A command's default is read-only even if a config would otherwise allow writes.
    const exec = args.includes('exec') || args.includes('e');
    const execDefault = argumentLists.some(
      (argv, index) =>
        (argv.includes('exec') || argv.includes('e')) &&
        !codexSandbox(argv).length &&
        !(values(argv, ['-p', '--profile']).length && configs[index].sandbox) &&
        !has(argv, '--full-auto', '--dangerously-bypass-approvals-and-sandbox'),
    );
    readonly = flags.includes('read-only') || configs.some((value) => value.sandbox === 'read-only') || execDefault;
    const sandbox = flags.at(-1) ?? (bypass ? 'danger-full-access' : full ? 'workspace-write' : config.sandbox);
    if (bypass || sandbox === 'danger-full-access') mode = 'write-anywhere';
    else if (
      sandbox === 'workspace-write' ||
      (!sandbox && cwd && config.trusted.some((path) => pathKey(path) === pathKey(cwd)))
    )
      mode = 'write';
    roots.push(...values(args, ['--add-dir']), ...config.roots);
    if (config.sandbox) evidence.push('config: sandbox_mode');
    if (mode === 'write' && !sandbox) evidence.push('config: trusted cwd');
    if (exec && readonly) evidence.push('codex: exec read-only');
  } else if (client === 'gemini') {
    const flags = values(args, ['--approval-mode']);
    readonly = flags.includes('plan');
    if (has(args, '-y', '--yolo') || flags.at(-1) === 'yolo') mode = 'write-anywhere';
    roots.push(...values(args, ['--include-directories'], true).flatMap((value) => value.split(',')));
  } else if (client === 'grok') {
    const config = toml(input.config?.grokToml);
    const flags = values(args, ['--permission-mode']);
    readonly = flags.includes('plan') || config.mode === 'plan';
    if ((flags.at(-1) ?? config.mode) === 'bypassPermissions' || (!flags.length && config.yolo))
      mode = 'write-anywhere';
    if (config.mode || config.yolo !== undefined) evidence.push('config: permission_mode/yolo');
  } else if (client === 'cursor') {
    readonly = has(args, '--plan') || values(args, ['--mode']).includes('plan');
    if (has(args, '-f', '--force', '--yolo')) mode = 'write-anywhere';
    roots.push(...values(args, ['--workspace']), ...values(args, ['--add-dir'], true));
  }
  // Only a Claude Code seen in the process chain is trusted; a clientInfo name alone is not.
  // Roots widen where, never whether, an inherited caller may write. The owner's 'write' override treats them
  // like probed roots, including for a read-only caller.
  if (client === 'claude' && observed.some((entry) => entry.client === 'claude') && input.clientRoots?.length) {
    roots.push(...input.clientRoots);
    evidence.push('roots: client');
  }
  if (readonly) {
    mode = 'read-only';
    evidence.push('permission: read-only signal');
  }
  const wsl =
    input.envNames.includes('WSL_DISTRO_NAME') ||
    input.envNames.includes('WSL_INTEROP') ||
    input.chain.some((entry) => /^\/(?:proc\/|mnt\/[a-z](?:\/|$))/.test(entry.exe)) ||
    /^\/mnt\/[a-z](?:\/|$)/i.test(input.cwd ?? '');
  if (wsl) evidence.push('process: not verified from Windows');
  if (conflict) {
    mode = 'unknown';
    evidence.push('identity: conflict');
  }
  if (cwd && systemDirectory(cwd)) {
    mode = 'unknown';
    evidence.push('cwd: system directory or home');
  }
  if (input.timedOut && !input.chain.length) evidence.push('probe: timeout');
  const verified = observed.length > 0 && !conflict && !wsl && mode !== 'unknown';
  if (!verified && mode !== 'unknown') {
    mode = 'unknown';
    evidence.push('identity: not verified');
  }
  evidence.push(`permission: ${mode}`);
  const network =
    mode === 'write-anywhere' ||
    (mode === 'write' && (client === 'codex' ? codexWorkspaceNetwork === true : client !== 'unknown'));
  const unique = new Map<string, string>();
  for (const root of roots.filter(Boolean)) {
    const path = normalize(root, cwd);
    if (/^(?:[a-z]:\\|\/)/i.test(path)) unique.set(pathKey(path), path);
  }
  return {
    client,
    ...(info === client && input.clientInfo?.version ? { version: input.clientInfo.version } : {}),
    mode,
    network,
    roots: [...unique.values()],
    ...(cwd ? { cwd } : {}),
    evidence,
    verified,
  };
}
