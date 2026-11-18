import * as fs from 'node:fs';
import path from 'node:path';
import type { Host, RunOptions, RunResult } from '../../src/server/platform/host.ts';

type FakePlatform = 'win32' | 'darwin' | 'linux';

const homes: Record<FakePlatform, string> = {
  win32: 'C:\\Users\\fixture',
  darwin: '/Users/fixture',
  linux: '/home/fixture',
};
const temporary: Record<FakePlatform, string> = {
  win32: 'C:\\Users\\fixture\\AppData\\Local\\Temp',
  darwin: '/var/folders/fx/fixture/T',
  linux: '/tmp',
};

const missing = (call: string) =>
  Object.assign(new Error(`fake host has no file system (${call})`), { code: 'ENOENT' }) as NodeJS.ErrnoException;

/**
 * A file system where nothing exists and nothing can be written, so a fake macOS or Linux host can never touch
 * the real disk by accident. Tests that need files pass `fs` (usually the real one, inside a temporary folder).
 */
export const emptyFs = new Proxy({} as typeof fs, {
  get(_target, name: string) {
    if (name === 'constants') return fs.constants;
    if (name === 'promises')
      return new Proxy({} as typeof fs.promises, {
        get: (_inner, call: string) => async () => {
          throw missing(`promises.${call}`);
        },
      });
    if (name === 'existsSync') return () => false;
    return () => {
      throw missing(name);
    };
  },
});

/** `emptyFs` with a few functions supplied (also inside `promises`). */
export function fakeFs(overrides: Record<string, unknown> & { promises?: Record<string, unknown> } = {}): typeof fs {
  const { promises = {}, ...sync } = overrides;
  return new Proxy(emptyFs, {
    get(target, name: string) {
      if (name === 'promises')
        return new Proxy(target.promises, { get: (inner, call: string) => promises[call] ?? Reflect.get(inner, call) });
      return sync[name] ?? Reflect.get(target, name);
    },
  });
}

/** Files that exist in a fake file system: path -> 'file', 'exec' (a file with execute permission), 'dir' or a link. */
export function fakeTree(entries: Record<string, 'file' | 'dir' | 'exec' | { link: string }>) {
  const stat = (path: string): fs.Stats => {
    const entry = entries[path];
    if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    if (typeof entry === 'object') return stat(entry.link);
    return { isFile: () => entry !== 'dir', isDirectory: () => entry === 'dir' } as fs.Stats;
  };
  return fakeFs({
    existsSync: (path: string) => {
      try {
        stat(path);
        return true;
      } catch {
        return false;
      }
    },
    statSync: stat,
    lstatSync: (path: string) => {
      const entry = entries[path];
      if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return {
        isFile: () => entry === 'file' || entry === 'exec',
        isDirectory: () => entry === 'dir',
        isSymbolicLink: () => typeof entry === 'object',
      } as fs.Stats;
    },
    realpathSync: (path: string) => {
      let current = path;
      for (let hops = 0; hops < 10; hops++) {
        const entry = entries[current];
        if (entry === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        if (typeof entry !== 'object') return current;
        current = entry.link;
      }
      throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
    },
    accessSync: (path: string) => {
      if (entries[path] !== 'exec') throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
    },
  });
}

export type FakeRun = (file: string, args: readonly string[], options?: RunOptions) => RunResult | Promise<RunResult>;

/** A host for one platform: its own path rules, a fixture home, and no programs or files unless given. */
export function fakeHost(
  platform: FakePlatform,
  overrides: Partial<Omit<Host, 'run' | 'runSync'>> & { run?: FakeRun; runSync?: Host['runSync'] } = {},
): Host {
  const { run, ...rest } = overrides;
  return {
    platform,
    env: {},
    home: homes[platform],
    tmpdir: temporary[platform],
    path: platform === 'win32' ? path.win32 : path.posix,
    fs: emptyFs,
    runSync: (file) => {
      throw missing(`run ${file}`);
    },
    freemem: () => 4 * 1024 ** 3,
    totalmem: () => 16 * 1024 ** 3,
    uid: () => (platform === 'win32' ? undefined : 501),
    ...rest,
    run: async (file, args, options) => {
      if (!run) throw missing(`run ${file}`);
      return run(file, args, options);
    },
  };
}

/**
 * Environment that points this machine's per-user app folders below `folder`, and where the memory base then
 * is: Windows LOCALAPPDATA, macOS HOME (…/Library/Application Support), Linux XDG_DATA_HOME.
 */
export function appDataEnv(folder: string): { env: NodeJS.ProcessEnv; memoryAnchor: string; memoryBase: string } {
  if (process.platform === 'win32')
    return { env: { LOCALAPPDATA: folder }, memoryAnchor: folder, memoryBase: path.join(folder, 'ComboRunner') };
  if (process.platform === 'darwin') {
    const anchor = path.join(folder, 'Library', 'Application Support');
    return { env: { HOME: folder }, memoryAnchor: anchor, memoryBase: path.join(anchor, 'PugPort') };
  }
  return { env: { XDG_DATA_HOME: folder }, memoryAnchor: folder, memoryBase: path.join(folder, 'pugport') };
}

/** Records every program a fake host is asked to run. */
export function recordingRun(reply: (file: string, args: readonly string[]) => string | Error = () => '') {
  const calls: { file: string; args: string[]; options?: RunOptions }[] = [];
  const run: FakeRun = (file, args, options) => {
    calls.push({ file, args: [...args], ...(options ? { options } : {}) });
    const result = reply(file, args);
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: '' };
  };
  return { calls, run };
}
