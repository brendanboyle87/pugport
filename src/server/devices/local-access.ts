import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { StoredDevice } from './store.ts';

/** Read configuration only: never invoke ssh (Match exec can run commands). */
export function hasSshAlias(
  file: string,
  alias: string,
  visited = new Set<string>(),
  configDirectory = dirname(file),
): boolean {
  const absolute = resolve(file);
  if (visited.has(absolute) || visited.size >= 32) return false;
  visited.add(absolute);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const words =
      line
        .replace(/\s+#.*$/, '')
        .trim()
        .match(/"[^"]*"|'[^']*'|[^\s=]+/g)
        ?.map((word) => word.replace(/^["']|["']$/g, '')) ?? [];
    const directive = words.shift()?.toLowerCase();
    if (directive === 'host') {
      const match = (pattern: string) =>
        new RegExp(
          `^${pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replaceAll('*', '.*')
            .replaceAll('?', '.')}$`,
          'i',
        ).test(alias);
      if (
        words.some((word) => word !== '*' && !word.startsWith('!') && match(word)) &&
        !words.some((word) => word.startsWith('!') && match(word.slice(1)))
      )
        return true;
    }
    if (directive === 'include')
      for (const pattern of words) {
        // User config includes are relative to ~/.ssh, even from an included file.
        const expanded = pattern.startsWith('~/')
          ? join(dirname(configDirectory), pattern.slice(2))
          : isAbsolute(pattern)
            ? pattern
            : join(configDirectory, pattern);
        try {
          for (const included of globSync(expanded))
            if (hasSshAlias(included, alias, visited, configDirectory)) return true;
        } catch {
          /* Missing includes do not grant tunnel access. */
        }
      }
  }
  return false;
}

export class LocalDeviceAccess {
  constructor(
    private readonly peersFile: string,
    private readonly sshConfigFile: string,
  ) {}
  isSelf(device: StoredDevice): boolean {
    try {
      const data = JSON.parse(readFileSync(this.peersFile, 'utf8')) as {
        nodeId?: string;
        peers?: { id: string; tokenHash: string }[];
      };
      if (device.nodeId && data.nodeId === device.nodeId) return true;
      const hash = createHash('sha256').update(device.token).digest('hex');
      return (
        Array.isArray(data.peers) && data.peers.some((peer) => peer.id === device.peerId && peer.tokenHash === hash)
      );
    } catch {
      return false;
    }
  }
  sshAvailable(alias: string): boolean {
    return hasSshAlias(this.sshConfigFile, alias);
  }
}
