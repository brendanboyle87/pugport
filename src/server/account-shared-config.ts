import { providerSpec } from '../shared/provider-registry.ts';
import { isolatedUserPath } from './platform/under-test.ts';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RuntimeTarget } from '../shared/types.ts';
import { currentHost } from './platform/host.ts';
import { restrictDirectory } from './platform/secure-file.ts';
import { sanitizeCodexConfig } from './account-config-toml.ts';
import { fileIdentity } from './platform/file-identity.ts';

type Ledger = { version: 1; files: Record<string, string>; links: Record<string, string> };
const pending = new Map<string, Promise<void>>();
const notes = new Map<string, string>();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const info = (file: string) =>
  lstat(file, { bigint: true }).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });

/** Mirroring and removal share a queue so a launch cannot add a link while the folder is being recycled. */
export async function withAccountConfigLock<T>(home: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? resolve(home).toLowerCase() : resolve(home);
  const result = (pending.get(key) ?? Promise.resolve()).then(action);
  const settled = result.then(
    () => {},
    () => {},
  );
  pending.set(key, settled);
  try {
    return await result;
  } finally {
    if (pending.get(key) === settled) pending.delete(key);
  }
}

export function accountSharedConfigNote(target: RuntimeTarget): string | undefined {
  return target.accountHome ? notes.get(target.accountHome) : undefined;
}

async function ownText(file: string): Promise<string | undefined> {
  const entry = await info(file);
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.size > 4n * 1024n * 1024n)
    throw new Error('文件不是独立的普通文件');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      fileIdentity(opened).ino !== fileIdentity(entry).ino ||
      (process.platform !== 'win32' && fileIdentity(opened).dev !== fileIdentity(entry).dev) ||
      opened.nlink !== 1n ||
      opened.size > 4n * 1024n * 1024n ||
      !samePath(file, await realpath(file))
    )
      throw new Error('文件读取期间发生变化');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function claudeSettings(text: string): string {
  const settings: unknown = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('配置格式无效');
  const result = { ...settings } as Record<string, unknown>;
  for (const key of [
    'apiKeyHelper',
    'awsAuthRefresh',
    'awsCredentialExport',
    'otelHeadersHelper',
    'forceLoginMethod',
    'forceLoginOrgUUID',
    'apiKey',
    'primaryApiKey',
    'oauthAccount',
  ])
    delete result[key];
  if (result.env !== undefined) {
    if (!result.env || typeof result.env !== 'object' || Array.isArray(result.env)) throw new Error('环境配置无效');
    result.env = Object.fromEntries(
      Object.entries(result.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)),
    );
  }
  return JSON.stringify(result, null, 2) + '\n';
}

const realDirectory = async (path: string) => {
  const entry = await info(path);
  return !!entry && entry.isDirectory() && !entry.isSymbolicLink() && samePath(path, await realpath(path));
};

/**
 * Claude keeps each project's memory in `projects/<project>/memory`. Link the default profile's folders so every
 * account reads and writes the same notes instead of starting empty. An account's own non-empty memory is kept.
 */
async function shareProjectMemory(source: string, home: string, ledger: Ledger, issues: string[]): Promise<void> {
  const host = currentHost();
  const from = host.path.join(source, 'projects');
  const to = host.path.join(home, 'projects');
  // Links whose default folder has gone are removed, so the account can make its own again.
  for (const [key, target] of Object.entries(ledger.links)) {
    if (!key.startsWith('projects/') || (await info(target))) continue;
    const link = host.path.join(home, ...key.split('/'));
    const entry = await info(link);
    if (entry?.isSymbolicLink() && samePath(await readlink(link), target)) await unlink(link);
    delete ledger.links[key];
  }
  if (!(await realDirectory(from))) return;
  // A linked projects folder is refused before anything is read or created through it.
  if ((await info(to)) && !(await realDirectory(to))) {
    issues.push('项目记忆同步失败');
    return;
  }
  for (const project of await readdir(from, { withFileTypes: true })) {
    // Only real folders: files such as .DS_Store and linked project folders are skipped.
    if (!project.isDirectory()) continue;
    const key = `projects/${project.name}/memory`;
    try {
      const memory = host.path.join(from, project.name, 'memory');
      const shared = await info(memory);
      if (!shared?.isDirectory() || shared.isSymbolicLink()) continue;
      const parent = host.path.join(to, project.name);
      const folder = await info(parent);
      if (folder && (!folder.isDirectory() || folder.isSymbolicLink())) throw new Error('项目目录无效');
      const link = host.path.join(parent, 'memory');
      const existing = await info(link);
      if (existing?.isSymbolicLink()) {
        const current = await readlink(link);
        // Already shared, including by a launch whose ledger write failed.
        if (samePath(current, memory)) {
          ledger.links[key] = memory;
          continue;
        }
        if (!ledger.links[key] || !samePath(current, ledger.links[key]!)) {
          issues.push('项目记忆已有内容，已保留');
          continue;
        }
        await unlink(link);
      } else if (existing) {
        if (!(await realDirectory(link)) || (await readdir(link)).length) {
          issues.push('项目记忆已有内容，已保留');
          continue;
        }
        // An empty folder Claude made before the memory was shared.
        await rmdir(link);
      }
      if (!(await info(to))) {
        await mkdir(to, { mode: 0o700 });
        if (!(await realDirectory(to))) throw new Error('项目目录无效');
      }
      if (!folder) await mkdir(parent, { mode: 0o700 });
      await symlink(memory, link, host.platform === 'win32' ? 'junction' : 'dir');
      ledger.links[key] = memory;
    } catch {
      issues.push('项目记忆同步失败');
    }
  }
}

/** Only these personal files and extension directories are shared. No profile enumeration or authentication reads. */
async function mirror(target: RuntimeTarget, environment: NodeJS.ProcessEnv): Promise<void> {
  const host = currentHost();
  const dir = providerSpec(target.provider)!.configDir!;
  const home = dir.envIsParent ? host.path.join(target.accountHome!, dir.name) : target.accountHome!;
  const env = (name: string) =>
    environment[
      Object.keys(environment).find((key) => (host.platform === 'win32' ? key.toUpperCase() === name : key === name)) ??
        ''
    ];
  const base = isolatedUserPath(env(host.platform === 'win32' ? 'USERPROFILE' : 'HOME') || host.home);
  const source = isolatedUserPath(
    dir.envIsParent ? resolve(env(dir.env) || base, dir.name) : resolve(env(dir.env) || host.path.join(base, dir.name)),
  );
  const homeInfo = await lstat(home);
  if (
    !homeInfo.isDirectory() ||
    homeInfo.isSymbolicLink() ||
    !samePath(home, await realpath(home)) ||
    samePath(home, source)
  )
    throw new Error('账号目录无效');
  const sourceInfo = await info(source);
  if (!sourceInfo) {
    notes.delete(target.accountHome!);
    return;
  }
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('默认配置目录无效');
  await restrictDirectory(home);
  const ledgerPath = host.path.join(home, '.pugport-shared-config.json');
  const previous = await ownText(ledgerPath);
  const ledger: Ledger = previous ? JSON.parse(previous) : { version: 1, files: {}, links: {} };
  if (
    ledger.version !== 1 ||
    !ledger.files ||
    !ledger.links ||
    typeof ledger.files !== 'object' ||
    typeof ledger.links !== 'object'
  )
    throw new Error('同步记录无效');
  const issues: string[] = [];
  const directories =
    target.provider === 'claude' ? ['skills', 'agents', 'commands', 'output-styles', 'plugins'] : ['skills', 'prompts'];
  for (const name of directories) {
    try {
      const from = host.path.join(source, name);
      const to = host.path.join(home, name);
      const sourceEntry = await info(from);
      if (!sourceEntry) continue;
      if (!(await stat(from)).isDirectory()) throw new Error('扩展目录无效');
      const existing = await info(to);
      if (existing) {
        if (!existing.isSymbolicLink() || !ledger.links[name] || !samePath(await readlink(to), ledger.links[name]!)) {
          issues.push(`${name} 已有内容，已保留`);
          continue;
        }
        if (samePath(await readlink(to), from)) continue;
        await unlink(to);
      }
      await symlink(from, to, host.platform === 'win32' ? 'junction' : 'dir');
      ledger.links[name] = from;
    } catch {
      issues.push(`${name} 同步失败`);
    }
  }
  if (target.provider === 'claude') {
    try {
      await shareProjectMemory(source, home, ledger, issues);
    } catch {
      issues.push('项目记忆同步失败');
    }
  }
  const files = target.provider === 'claude' ? ['CLAUDE.md', 'settings.json'] : ['AGENTS.md', 'config.toml'];
  for (const name of files) {
    try {
      const from = host.path.join(source, name);
      const to = host.path.join(home, name);
      const raw = await ownText(from);
      if (raw === undefined) continue;
      const text =
        name === 'settings.json' ? claudeSettings(raw) : name === 'config.toml' ? sanitizeCodexConfig(raw) : raw;
      const current = await ownText(to);
      if (current !== undefined && (ledger.files[name] ? hash(current) !== ledger.files[name] : current !== text)) {
        issues.push(`${name} 已手动修改，已保留`);
        continue;
      }
      if (current !== text || (await stat(from)).mtimeMs > (await stat(to)).mtimeMs) {
        // Recheck after reading the source; do not overwrite a concurrent manual edit.
        if ((await ownText(to)) !== current) {
          issues.push(`${name} 已手动修改，已保留`);
          continue;
        }
        await atomicWrite(to, text);
      }
      ledger.files[name] = hash(text);
    } catch {
      issues.push(`${name} 同步失败`);
    }
  }
  const serialized = JSON.stringify(ledger);
  if ((Object.keys(ledger.files).length || Object.keys(ledger.links).length) && serialized !== previous)
    await atomicWrite(ledgerPath, serialized);
  if (issues.length)
    notes.set(target.accountHome!, `个人配置：${issues[0]}${issues.length > 1 ? '，另有项目未同步' : ''}。`);
  else notes.delete(target.accountHome!);
}

/** Serialize simultaneous launches for a profile; configuration failures must never prevent a CLI launch. */
export async function mirrorAccountSharedConfig(
  target: RuntimeTarget,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (
    !target.accountId ||
    !target.accountHome ||
    target.environment !== 'native' ||
    target.gateway ||
    !providerSpec(target.provider)?.configDir
  )
    return;
  const home = target.accountHome;
  await withAccountConfigLock(home, async () => {
    try {
      await mirror(target, environment);
    } catch {
      notes.set(home, '个人配置同步失败，仍可启动；请检查目录和配置文件。');
    }
  });
}
