import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appDirs } from './dirs.ts';
import { currentHost } from './host.ts';
import { isolatedUserPath } from './under-test.ts';

/**
 * Machine-local, per-user discovery only. Never a URL, token, or executable configuration.
 * On Windows a desktop started by a packaged app (Codex, Claude) has its AppData writes redirected into that app's
 * private folder, where no other program finds them; the profile folder itself is not redirected.
 */
export const desktopEndpointFile = () => {
  const host = currentHost();
  return host.platform === 'win32'
    ? join(isolatedUserPath(host.home), '.pugport', 'desktop-endpoint.json')
    : legacyDesktopEndpointFile();
};
/** Where earlier desktops published; still written and read so older helpers and desktops keep finding each other. */
const legacyDesktopEndpointFile = () => join(appDirs().memoryBase, 'desktop-endpoint.json');
const endpointFiles = () => [...new Set([desktopEndpointFile(), legacyDesktopEndpointFile()])];

function readEndpoint(file: string): number | undefined {
  try {
    if (statSync(file).size > 1024) return undefined;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) return undefined;
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.instance !== 'string') return undefined;
    process.kill(value.pid, 0);
    return value.port;
  } catch {
    return undefined;
  }
}

/** The first live entry; a stale one (its desktop has exited) is skipped. */
export function readDesktopPort(file?: string): number | undefined {
  for (const candidate of file ? [file] : endpointFiles()) {
    const port = readEndpoint(candidate);
    if (port !== undefined) return port;
  }
  return undefined;
}

/** Publish only after the owned child's exact handshake; cleanup cannot erase another desktop's entry. */
export function publishDesktopPort(port: number, file?: string): () => void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid desktop port');
  const text = JSON.stringify({ port, pid: process.pid, instance: randomUUID() });
  const written: string[] = [];
  let failure: unknown;
  for (const target of file ? [file] : endpointFiles()) {
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, target);
      written.push(target);
    } catch (error) {
      failure ??= error;
    } finally {
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
  if (!written.length) throw failure;
  // The other place still works, but a helper that only looks there may miss this desktop.
  if (failure) console.warn('Desktop port discovery written to one place only:', failure);
  return () => {
    for (const target of written)
      try {
        if (readFileSync(target, 'utf8') === text) unlinkSync(target);
      } catch {}
  };
}

export const forwardTokenFile = () => {
  const host = currentHost();
  return host.platform === 'win32'
    ? join(isolatedUserPath(host.home), '.pugport', 'desktop-forward.json')
    : join(appDirs().memoryBase, 'desktop-forward.json');
};

/** The token of the desktop listening on `port`; another desktop process's token (a dev or test backend) is ignored. */
export function readForwardToken(file = forwardTokenFile(), port?: number): string | undefined {
  try {
    if (statSync(file).size > 1024) return undefined;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value.token !== 'string' || !value.token || !Number.isSafeInteger(value.pid) || value.pid < 1)
      return undefined;
    if (port !== undefined && value.port !== port) return undefined;
    process.kill(value.pid, 0);
    return value.token;
  } catch {
    return undefined;
  }
}

export function publishForwardToken(token: string, port: number, file = forwardTokenFile()): () => void {
  const text = JSON.stringify({ token, pid: process.pid, port });
  const temporary = `${file}.${process.pid}.tmp`;
  let created = false;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // A leftover from an earlier process with the same PID is replaced, never reused with its old permissions.
    try {
      unlinkSync(temporary);
    } catch {}
    const fd = openSync(temporary, 'wx', 0o600);
    created = true;
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    if (created)
      try {
        unlinkSync(temporary);
      } catch {}
  }
  return () => {
    try {
      if (readFileSync(file, 'utf8') === text) unlinkSync(file);
    } catch {}
  };
}

export const sessionTokenDirectory = () => join(isolatedUserPath(currentHost().home), '.pugport');
export const sessionTokenFile = (port: number) => join(sessionTokenDirectory(), `session-${port}.json`);

export function readSessionToken(port: number, file = sessionTokenFile(port)): string | undefined {
  return readForwardToken(file, port);
}

/** Windows relies on the user profile folder's inherited ACL. */
export function publishSessionToken(token: string, port: number, file = sessionTokenFile(port)): () => void {
  return publishForwardToken(token, port, file);
}
