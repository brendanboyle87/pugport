import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SyncValue } from '../shared/account-sync.ts';

function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return;
  const scp = /^[^\s/@:]+@([^\s/:]+):(.+)$/.exec(value);
  const candidate = scp ? `ssh://${scp[1]}/${scp[2]}` : value;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return;
  }
}

/** Read only the literal origin URL. Never execute Git, includes, credential helpers or repository config. */
export function projectSyncIdentity(project: SyncValue): string | undefined {
  if (typeof project.path !== 'string' || !project.path) return normalizeOrigin(project.gitRemote);
  try {
    let git = join(project.path, '.git');
    if (statSync(git).isFile()) {
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(git, 'utf8'))?.[1];
      if (!pointer) return;
      git = resolve(project.path, pointer.trim());
    }
    try {
      git = resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim());
    } catch {
      /* Ordinary checkout. */
    }
    if (statSync(join(git, 'config')).size > 1024 * 1024) return;
    const config = readFileSync(join(git, 'config'), 'utf8');
    const origin = /^\s*\[remote\s+"origin"\]\s*\r?\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(config)?.[1];
    let url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(origin ?? '')?.[1];
    if (!url) return;
    if (url.startsWith('"') && url.endsWith('"')) url = url.slice(1, -1);
    return normalizeOrigin(url);
  } catch {
    return;
  }
}
