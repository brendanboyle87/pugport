import { execFile, spawn } from './platform/test-process.ts';
import { lstat, opendir, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { memoryStorageRoot } from './local-memory.ts';
import { localToolStatus } from './local-tools.ts';
import { voiceModelDirectory } from './voice.ts';
import { imageIndexStatus } from './image-search.ts';
import { runToolInstaller } from './tool-installer.ts';
import { currentHost, type Host } from './platform/host.ts';
import type { LayaSettings } from '../shared/laya.ts';

/** Preserve local installation and recording preferences while adopting the cloud default once. */
export function loadLayaSettings(saved?: LayaSettings): LayaSettings {
  return {
    enabled: false,
    recordTraining: true,
    ...saved,
    mode: saved?.mode ?? 'cloud',
    ...(saved?.shareTraining === undefined && saved?.recordTraining === false ? { shareTraining: false } : {}),
  };
}

/** Settings that live outside settings.json, so the app can change them without editing files by hand. */
const run = promisify(execFile);
export function appPaths(dataDir: string) {
  return { dataDir, memoryDir: memoryStorageRoot(dataDir) };
}

/** Opens one of the app's own folders in the system file manager. */
export function openFolder(path: string) {
  const [command, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [path]]
      : process.platform === 'darwin'
        ? ['open', [path]]
        : ['xdg-open', [path]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

export type ReplyPathCandidates = { paths: string[]; truncated?: boolean };
const replySearchLimit = 20;
const replySearchIgnored = new Set([
  '.git',
  'node_modules',
  '$recycle.bin',
  'recycler',
  'system volume information',
  'windows',
  '$windows.~bt',
  '$windows.~ws',
  'recovery',
]);
const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const inside = (root: string, path: string) => {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`);
};

/** Resolves only when clicked. A short name never causes a whole-drive search or picks an arbitrary match. */
export async function resolveReplyPathCandidates(
  requested: string,
  bases: string[] = [],
  projectPath?: string,
): Promise<ReplyPathCandidates> {
  requested = requested.trim();
  const invalid = (value: string) => !value || /[\0"\r\n]/.test(value);
  if (
    invalid(requested) ||
    requested.length > 4000 ||
    bases.some((base) => invalid(base) || !isAbsolute(base)) ||
    (projectPath !== undefined && (invalid(projectPath) || !isAbsolute(projectPath)))
  )
    throw new Error('路径无效。');
  if (isAbsolute(requested)) {
    if (!(await stat(requested).catch(() => undefined))) throw new Error(`找不到：${requested}`);
    return { paths: [requested] };
  }
  if ((!bases.length && !projectPath) || /(^|[\\/])\.\.([\\/]|$)/.test(requested) || /[:*?<>|]/.test(requested))
    throw new Error('路径无效。');
  const target = requested.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
  const project = projectPath ? resolve(projectPath) : undefined;
  const baseDirs = new Map<string, string>();
  const directDirs = new Map<string, string>();
  for (const base of bases.slice(0, 40)) {
    const info = await stat(base).catch(() => undefined);
    let dir = resolve(info?.isDirectory() ? base : dirname(base));
    // Missing names can still be resolved by an exact sibling; they do not justify a recursive search.
    if (info && dirname(dir) !== dir) baseDirs.set(pathKey(dir), dir);
    for (let level = 0; level < 5 && dirname(dir) !== dir; level++, dir = dirname(dir)) {
      if (project && !inside(project, dir) && level > 0) break;
      directDirs.set(pathKey(dir), dir);
      if (project && pathKey(dir) === pathKey(project)) break;
    }
  }
  const result = (paths: Iterable<string>, truncated = false): ReplyPathCandidates => {
    const unique = [...new Map([...paths].map((path) => [pathKey(path), path])).values()];
    return {
      paths: unique.slice(0, replySearchLimit),
      ...(truncated || unique.length > replySearchLimit ? { truncated: true } : {}),
    };
  };
  const inspected = new Map<string, boolean>();
  const safePath = async (root: string, path: string, ignoreSystemFolders = false) => {
    if (!inside(root, path)) return false;
    const parts = relative(root, path).split(sep);
    if (ignoreSystemFolders && parts.some((part) => replySearchIgnored.has(part.toLowerCase()))) return false;
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      if (!inspected.has(current)) {
        const info = await lstat(current).catch(() => undefined);
        inspected.set(current, !!info && !info.isSymbolicLink());
      }
      if (!inspected.get(current)) return false;
    }
    return true;
  };
  const existing = async (dirs: Iterable<string>) => {
    const matches: string[] = [];
    for (const dir of dirs) {
      const path = join(dir, target);
      if (!(await safePath(dir, path))) continue;
      const info = await lstat(path).catch(() => undefined);
      if (info && !info.isSymbolicLink() && (info.isFile() || info.isDirectory())) matches.push(path);
    }
    return matches;
  };
  // An explicit folder named by this reply is stronger evidence than a project-wide filename match.
  const nearby = await existing(directDirs.values());
  if (nearby.length) return result(nearby);
  if (project) {
    const exact = await existing([project]);
    if (exact.length) return result(exact);
  }
  const scope = project ? [project, ...baseDirs.values()] : [...baseDirs.values()];
  const roots = [
    ...new Map(scope.filter((dir) => dirname(dir) !== dir).map((dir) => [pathKey(dir), dir])).values(),
  ].filter((dir, _, all) => !all.some((other) => other !== dir && inside(other, dir)));
  const exact = new Set<string>();
  const stems = new Set<string>();
  let truncated = false;
  const targetKey = pathKey(target);
  const accepts = (root: string, path: string, file: boolean) => {
    const tail = relative(root, path);
    const key = pathKey(tail);
    if (key === targetKey || key.endsWith(`${sep}${targetKey}`)) exact.add(path);
    else if (file && !extname(target) && extname(path)) {
      const stem = key.slice(0, -extname(path).length);
      if (stem === targetKey || stem.endsWith(`${sep}${targetKey}`)) stems.add(path);
    }
  };
  const deadline = Date.now() + 1500;
  let entries = 0,
    dirs = 0;
  const walkRoots: string[] = [];
  for (const root of roots) if (!(await lstat(root).catch(() => undefined))?.isSymbolicLink()) walkRoots.push(root);
  const queue = walkRoots.map((root) => ({ root, path: root, depth: 0 }));
  for (let index = 0; index < queue.length; index++) {
    if (Date.now() > deadline || entries >= 20_000 || dirs >= 1000) {
      truncated = true;
      break;
    }
    const item = queue[index]!;
    const folder = await opendir(item.path).catch(() => undefined);
    if (!folder) {
      truncated = true;
      continue;
    }
    dirs++;
    for await (const entry of folder) {
      if (++entries > 20_000 || Date.now() > deadline) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink() || replySearchIgnored.has(entry.name.toLowerCase())) continue;
      const path = join(item.path, entry.name);
      if (entry.isFile() || entry.isDirectory()) accepts(item.root, path, entry.isFile());
      if (entry.isDirectory()) {
        if (item.depth < 6) queue.push({ root: item.root, path, depth: item.depth + 1 });
        else truncated = true;
      }
      if (exact.size > replySearchLimit) {
        truncated = true;
        break;
      }
    }
    if (exact.size > replySearchLimit) break;
  }
  return result(exact.size ? exact : stems, truncated);
}

/** Used by older callers which cannot offer a choice: ambiguity must never open the wrong file. */
export async function resolveReplyPath(requested: string, bases: string[] = [], projectPath?: string): Promise<string> {
  const candidates = await resolveReplyPathCandidates(requested, bases, projectPath);
  if (candidates.truncated) throw new Error(`搜索范围较大，请提供更完整的路径：${requested}`);
  if (candidates.paths.length > 1) throw new Error(`找到多个同名文件或文件夹，请选择完整路径：${requested}`);
  if (!candidates.paths.length) throw new Error(`找不到：${requested}`);
  return candidates.paths[0]!;
}

export async function revealPath(requested: string, bases: string[] = []): Promise<void> {
  const { stat } = await import('node:fs/promises');
  const path = await resolveReplyPath(requested, bases);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`找不到：${path}`);
  const { command, args } = revealCommand(path, info.isDirectory());
  if (process.platform === 'win32')
    spawn(command, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  else spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

/**
 * Shows a file in its folder: Explorer and Finder select it; Linux file managers have no common way to select,
 * so the folder opens. A folder itself opens.
 */
export function revealCommand(path: string, directory: boolean, host: Host = currentHost()) {
  if (host.platform === 'win32')
    return { command: 'explorer.exe', args: [directory ? `"${path}"` : `/select,"${path}"`] };
  if (host.platform === 'darwin') return { command: 'open', args: directory ? [path] : ['-R', path] };
  return { command: 'xdg-open', args: [directory ? path : host.path.dirname(path)] };
}

export function toolStatus(appRoot: string) {
  return { ...localToolStatus(appRoot), voice: !!voiceModelDirectory(appRoot), images: imageIndexStatus(appRoot) };
}

const installers = {
  documents: 'markitdown',
  voice: 'voice',
  images: 'image-search',
  memory: 'memory-search',
} as const;
export type InstallableTool = keyof typeof installers;

/** Compatibility entry point; shares one installer process with the extension catalog. */
export function installTool(appRoot: string, tool: InstallableTool): Promise<string> {
  return runToolInstaller(appRoot, installers[tool]);
}
