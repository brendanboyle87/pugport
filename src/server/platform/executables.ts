import { isolatedUserPath } from './under-test.ts';
import { currentHost, type Host } from './host.ts';
import { loginShellPath } from './shell-env.ts';

/** Saved MCP commands use the API harness too, so provider retirement alone cannot block these CLIs. */
export function isRemovedGoogleCliLaunch(target: { command?: unknown; args?: unknown } | null | undefined): boolean {
  if (
    !target ||
    typeof target.command !== 'string' ||
    (target.args !== undefined && (!Array.isArray(target.args) || !target.args.every((arg) => typeof arg === 'string')))
  )
    return false;
  const executable = target.command
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)!
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
  const officialPackage = /(?:^|[\\/]|--package=|-p=)@google[\\/]gemini-cli(?:[\\/]|@[^\\/]*$|$)/i;
  return (
    /^(?:gemini|agy)$/i.test(executable) ||
    officialPackage.test(target.command) ||
    (/^(?:node|npm|npx|pnpm|pnpx|yarn|bun|bunx)$/i.test(executable) &&
      (target.args ?? []).some((arg: string) => officialPackage.test(arg)))
  );
}

const isFile = (path: string, host: Host) => {
  try {
    return host.fs.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `prefix=` from ~/.npmrc (or the environment), where `npm install -g` puts its links. */
function npmPrefix(host: Host): string | undefined {
  const { env, path, home } = host;
  let prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (!prefix) {
    try {
      prefix = /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(
        host.fs.readFileSync(path.join(host === currentHost() ? isolatedUserPath(home) : home, '.npmrc'), 'utf8'),
      )?.[1];
    } catch {
      return undefined;
    }
  }
  if (!prefix) return undefined;
  prefix = prefix.replace(/^["']|["']$/g, '').replace(/^(?:~|\$\{HOME\}|\$HOME)(?=\/|$)/, home);
  return path.isAbsolute(prefix) ? path.join(prefix, 'bin') : undefined;
}

/** The newest Node installed by nvm (`~/.nvm/versions/node/vX.Y.Z/bin`). */
function newestNvm(host: Host): string | undefined {
  const root = host.path.join(host.env.NVM_DIR || host.path.join(host.home, '.nvm'), 'versions', 'node');
  try {
    const versions = host.fs
      .readdirSync(root)
      .map((name) => ({ name, parts: /^v(\d+)\.(\d+)\.(\d+)$/.exec(name)?.slice(1).map(Number) }))
      .filter((entry): entry is { name: string; parts: number[] } => !!entry.parts)
      .sort((a, b) => b.parts[0]! - a.parts[0]! || b.parts[1]! - a.parts[1]! || b.parts[2]! - a.parts[2]!);
    return versions[0] ? host.path.join(root, versions[0].name, 'bin') : undefined;
  } catch {
    return undefined;
  }
}

/** Folders searched after PATH, in order. A service or a Finder-started app may have almost nothing on PATH. */
export function searchDirs(host: Host = currentHost()): string[] {
  const { path, env, home } = host;
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.grok', 'bin'), path.join(home, 'bin')];
  if (host.platform === 'win32') {
    dirs.push(path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps'), path.join(env.APPDATA || '', 'npm'));
    return dirs;
  }
  const userTools = [
    npmPrefix(host),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    newestNvm(host),
  ];
  const fixed =
    host.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', ...userTools]
      : [
          '/usr/local/bin',
          ...userTools,
          '/snap/bin',
          '/home/linuxbrew/.linuxbrew/bin',
          path.join(home, '.linuxbrew', 'bin'),
        ];
  return [...new Set([...dirs, ...loginShellPath(host), ...fixed].filter((dir): dir is string => !!dir))];
}

/** The first file named `name` (Windows: .exe, .cmd, .bat, then bare) on PATH or in the search folders. */
export function findExecutable(name: string, host: Host = currentHost()): string | undefined {
  const extensions = host.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const locations = [
    ...(host.env.PATH ?? host.env.Path ?? '').split(host.path.delimiter).map((dir) => dir.replace(/^"|"$/g, '')),
    ...searchDirs(host),
  ];
  for (const dir of locations.filter(Boolean))
    for (const ext of extensions) {
      const path = host.path.join(dir, name + ext);
      if (isFile(path, host)) return path;
    }
  return undefined;
}

/**
 * `env` for a CLI started from `command`: its PATH first, then the CLI's own folder and the search folders. A
 * Finder-started app has only /usr/bin:/bin:/usr/sbin:/sbin, so npm's Codex (a `#!/usr/bin/env node` script
 * found in a search folder) could not find node. Windows: unchanged.
 */
export function cliEnvironment(command: string, env: NodeJS.ProcessEnv, host: Host = currentHost()): NodeJS.ProcessEnv {
  if (host.platform === 'win32') return env;
  const current = env.PATH ?? '';
  const present = current.split(':');
  const added = [...new Set([host.path.dirname(command), ...searchDirs(host)])].filter(
    (dir) => host.path.isAbsolute(dir) && !dir.includes(':') && !present.includes(dir),
  );
  return added.length ? { ...env, PATH: [current, ...added].filter(Boolean).join(':') } : env;
}

/**
 * A program that can be started directly with arguments, never through a command interpreter. Windows: an
 * absolute .exe file. macOS and Linux: an absolute path that resolves (npm, Homebrew and official installers
 * all link into a bin folder) to an executable file; .cmd/.bat/.ps1 wrappers are refused.
 */
export function isDirectExecutable(path: string, host: Host = currentHost()): boolean {
  try {
    if (!host.path.isAbsolute(path)) return false;
    if (host.platform === 'win32') return /\.exe$/i.test(path) && host.fs.statSync(path).isFile();
    if (/[\0\r\n]/.test(path) || /\.(cmd|bat|ps1)$/i.test(path)) return false;
    const real = host.fs.realpathSync(path);
    if (!host.fs.statSync(real).isFile()) return false;
    host.fs.accessSync(real, host.fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
