import { currentHost, type Host } from './host.ts';

const marker = '__PUGPORT_PATH__';
const cache = new WeakMap<Host, string[]>();

/** Pulls PATH out of a login shell's output, ignoring whatever its startup files print around it. */
export function parseLoginShellPath(output: string, host: Host = currentHost()): string[] {
  const match = new RegExp(`${marker}([^\\n]*?)${marker}`).exec(output);
  if (!match) return [];
  return [...new Set(match[1]!.split(':').filter((dir) => dir && host.path.isAbsolute(dir)))];
}

/**
 * Apps started from Finder, the Dock or launchd get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so CLIs
 * installed by Homebrew, npm or nvm are invisible and `#!/usr/bin/env node` scripts cannot start. On macOS the
 * user's login shell is asked once (3 s at most) and the answer kept for the life of the process; other systems
 * return nothing (a systemd unit sets PATH itself).
 */
export function loginShellPath(host: Host = currentHost()): string[] {
  if (host.platform !== 'darwin') return [];
  const known = cache.get(host);
  if (known) return known;
  const configured = host.env.SHELL;
  const shell =
    configured && host.path.isAbsolute(configured) && !/[\0\r\n]/.test(configured) ? configured : '/bin/zsh';
  let value: string[] = [];
  try {
    value = parseLoginShellPath(
      host.runSync(shell, ['-ilc', `printf '${marker}%s${marker}\\n' "$PATH"`], { timeout: 3000 }),
      host,
    );
  } catch {
    // A shell that fails or hangs only means the fixed fallback folders are searched.
  }
  cache.set(host, value);
  return value;
}
