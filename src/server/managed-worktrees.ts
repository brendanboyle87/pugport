import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
  chmod,
  rmdir,
  stat,
  symlink,
  appendFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { execFile } from './platform/test-process.ts';
import { trustedDirectory } from './platform/trusted-path.ts';
import { normalizeScope, withinScope } from '../shared/scope.ts';
import type {
  CommitManagedBranch,
  ManagedBranchCommit,
  ManagedWorktree,
  ManagedWorktreeDelivery,
  PrepareManagedWorktree,
  ManagedWorktreeRelease,
} from '../shared/managed-worktrees.ts';
export type {
  CommitManagedBranch,
  ManagedBranchCommit,
  ManagedWorktree,
  ManagedWorktreeDelivery,
  PrepareManagedWorktree,
} from '../shared/managed-worktrees.ts';

const limits = { files: 20000, bytes: 128 * 1024 * 1024, file: 16 * 1024 * 1024 };
type Entry = { path: string; mode: string; oid: string; hash: string };
type Snapshot = { head: string; tree: string; entries: Entry[] };
type Repo = { directory: string; common: string; head: string; index: string; format: 'sha1' | 'sha256' };
type Planned = { path: string; before?: Entry; after?: Entry };
type Journal = { state: 'applying' | 'completed'; childTree: string; parentBeforeTree: string; changes: Planned[] };
const queues = new Map<string, Promise<unknown>>();
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const stop = (signal?: AbortSignal) => signal?.throwIfAborted();

/** Git subprocesses never inherit redirection, execute hooks, or consult a credential prompt. */
async function git(
  cwd: string,
  args: string[],
  options: {
    input?: Buffer | string;
    index?: string;
    signal?: AbortSignal;
    allowFailure?: boolean;
    timeoutMs?: number;
    identity?: { name: string; email: string };
    readUserConfig?: boolean;
    /** Stop Git from discovering a repository above this directory. */
    ceiling?: string;
  } = {},
) {
  stop(options.signal);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  Object.assign(env, {
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    ...(options.ceiling ? { GIT_CEILING_DIRECTORIES: options.ceiling } : {}),
    GIT_AUTHOR_NAME: 'PugPort workspace',
    GIT_AUTHOR_EMAIL: 'workspace@pugport.invalid',
    GIT_COMMITTER_NAME: 'PugPort workspace',
    GIT_COMMITTER_EMAIL: 'workspace@pugport.invalid',
    ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
  });
  // Credential helpers on this machine live in the system config; a network push must be able to see them.
  if (options.readUserConfig) {
    delete env.GIT_CONFIG_GLOBAL;
    delete env.GIT_CONFIG_NOSYSTEM;
  }
  if (options.identity)
    Object.assign(env, {
      GIT_AUTHOR_NAME: options.identity.name,
      GIT_AUTHOR_EMAIL: options.identity.email,
      GIT_COMMITTER_NAME: options.identity.name,
      GIT_COMMITTER_EMAIL: options.identity.email,
    });
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>((done, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd,
        env,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: limits.bytes * 2,
        timeout: options.timeoutMs ?? 30000,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== 'number' || !options.allowFailure))
          reject(new Error(`Git ${args[0]} failed: ${stderr.toString().trim() || error.message}`));
        else done({ code: error ? (error.code as number) : 0, stdout, stderr: stderr.toString() });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input);
  });
}
async function gitText(cwd: string, args: string[], options: Parameters<typeof git>[2] = {}) {
  return (await git(cwd, args, options)).stdout.toString('utf8').trim();
}
/** Git for host publish: hooks stay off, and network calls can opt into the user's credential helper. */
export async function hostGit(cwd: string, args: string[], options: Parameters<typeof git>[2] = {}) {
  const result = await git(cwd, args, options);
  return { code: result.code, stdout: result.stdout.toString('utf8'), stderr: result.stderr };
}
async function disabledFilters(cwd: string, signal?: AbortSignal) {
  const result = await git(
    cwd,
    ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
    {
      signal,
      allowFailure: true,
    },
  );
  if (result.code > 1) throw new Error('Cannot inspect repository checkout filters.');
  const overrides: string[] = [];
  for (const key of result.stdout.toString().split(/\r?\n/).filter(Boolean)) {
    if (!/^filter\.[^\x00-\x20=]+\.(clean|smudge|process|required)$/.test(key))
      throw new Error('Unsupported repository checkout filter name.');
    overrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  return overrides;
}
export async function removeDetachedCheckout(repo: string, dir: string, signal?: AbortSignal) {
  await unlinkCheckoutLinks(dir);
  await git(repo, ['worktree', 'remove', '--force', dir], { signal, timeoutMs: 120_000 });
  await git(repo, ['worktree', 'prune'], { signal });
}

export async function createDetachedCheckout(repo: string, sha: string, dir: string, signal?: AbortSignal) {
  const overrides = await disabledFilters(repo, signal);
  await git(repo, [...overrides, '-c', 'core.symlinks=false', 'worktree', 'add', '--detach', dir, sha], {
    signal,
    timeoutMs: 120_000,
  });
  try {
    const head = await gitText(dir, ['rev-parse', 'HEAD'], { signal });
    const branch = await git(dir, ['symbolic-ref', '-q', 'HEAD'], { signal, allowFailure: true });
    const status = await gitText(dir, [...overrides, '-c', 'core.symlinks=false', 'status', '--porcelain'], { signal });
    if (head !== sha || branch.code === 0 || status) throw new Error('Detached checkout verification failed.');
  } catch (error) {
    try {
      await removeDetachedCheckout(repo, dir);
    } catch (cleanupError) {
      throw Object.assign(
        new Error(`Detached checkout verification and cleanup failed: ${String(cleanupError)}`, { cause: error }),
        {
          checkoutRetained: true,
        },
      );
    }
    throw error;
  }
}
async function branchSymlinkMode(cwd: string, signal?: AbortSignal): Promise<'native' | 'git-placeholder'> {
  const result = await git(cwd, ['config', '--type=bool', '--get', 'core.symlinks'], {
    readUserConfig: true,
    allowFailure: true,
    signal,
  });
  if (result.code > 1) throw new Error('Cannot verify the repository symlink setting.');
  if (result.code === 1) return process.platform === 'win32' ? 'git-placeholder' : 'native';
  const value = result.stdout.toString().trim();
  if (value !== 'true' && value !== 'false') throw new Error('Invalid repository symlink setting.');
  return value === 'true' ? 'native' : 'git-placeholder';
}
async function noLinks(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Linked path is not an owned workspace path: ${current}`);
    } catch (error) {
      if (!missing(error)) throw error;
      break;
    }
  }
  return absolute;
}
async function directory(path: string) {
  await noLinks(path);
  const canonical = await realpath(path);
  if (!samePath(canonical, path) || !(await lstat(canonical)).isDirectory()) throw new Error('Workspace path changed.');
  return canonical;
}
function validId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid managed workspace identifier.');
}
export class LaneWorkspaceValidationError extends Error {}
export function validBranch(branch: string) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(branch) ||
    branch === 'HEAD' ||
    branch.includes('..') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    throw new LaneWorkspaceValidationError('Invalid managed branch name.');
}
function validCommit(commit: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
    throw new LaneWorkspaceValidationError('Branch workspaces require a full commit object ID.');
}
function validFile(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    /[\\:\x00-\x1f]/.test(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /^\.git$/i.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error(`Unsupported workspace path: ${path}`);
}
async function checkedFile(root: string, path: string) {
  validFile(path);
  const full = resolve(root, ...path.split('/'));
  if (!inside(root, full) || samePath(root, full)) throw new Error('File escapes the workspace.');
  await noLinks(full);
  return full;
}
async function unlinkCheckoutLinks(root: string, recorded: string[] = []): Promise<string[]> {
  await noLinks(root);
  try {
    await lstat(root);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const tracked = new Set(
    (await git(root, ['ls-files', '--stage', '-z'])).stdout
      .toString()
      .split('\0')
      .filter((entry) => entry.startsWith('120000 '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1)),
  );
  const unlinked: string[] = [];
  for (const path of recorded) {
    validFile(path);
    if (tracked.has(path)) continue;
    const full = join(root, path);
    await noLinks(dirname(full));
    try {
      if ((await lstat(full)).isSymbolicLink()) {
        await unlink(full);
        unlinked.push(path);
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  async function walk(dir: string) {
    await noLinks(dir);
    // Walk ordinary directories only; a junction target must never become part of checkout cleanup.
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = relative(root, full);
      if (tracked.has(path.split(sep).join('/'))) continue;
      if ((await lstat(full)).isSymbolicLink()) {
        await unlink(full);
        unlinked.push(path);
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(root);
  return unlinked;
}
async function readOptional(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected an ordinary file: ${path}`);
    return await readFile(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function readSnapshotFile(path: string) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limits.file) throw new Error('Workspace snapshot exceeds its file limit.');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error('Source changed during snapshot; file size changed.');
    return Buffer.from(bytes.subarray(0, size));
  } finally {
    await handle.close();
  }
}
async function jsonWrite(path: string, value: unknown) {
  await noLinks(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await noLinks(path);
  await rename(temp, path);
}

export async function resolveLaneBase(sourceDirectory: string, base: string, signal?: AbortSignal): Promise<string> {
  if (base.startsWith('-')) throw new LaneWorkspaceValidationError(`工作线基础引用不能以“-”开头：${base}`);
  const result = await git(sourceDirectory, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], {
    signal,
    allowFailure: true,
  });
  if (result.code)
    throw new LaneWorkspaceValidationError(`无法解析工作线基础引用：${base}。请确认它是本地已有的引用或提交。`);
  const commit = result.stdout.toString().trim();
  validCommit(commit);
  return commit;
}

export async function assertLaneBranchAvailable(sourceDirectory: string, branch: string, signal?: AbortSignal) {
  validBranch(branch);
  if ((await git(sourceDirectory, ['check-ref-format', '--branch', branch], { signal, allowFailure: true })).code)
    throw new LaneWorkspaceValidationError('Invalid managed branch name.');
  const ref = await git(sourceDirectory, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`], {
    signal,
    allowFailure: true,
  });
  if (!ref.code)
    throw new LaneWorkspaceValidationError('Branch already exists; retained without adopting or resetting it.');
  const worktrees = await gitText(sourceDirectory, ['worktree', 'list', '--porcelain', '-z'], { signal });
  if (worktrees.split('\0').includes(`branch refs/heads/${branch}`))
    throw new LaneWorkspaceValidationError('Branch is checked out in another worktree; retained without changing it.');
}

/**
 * What `git add` and `git commit` need inside a linked worktree: its own Git directory plus the shared objects,
 * refs and (when present) logs. Never the common directory itself, config, hooks, info or packed-refs.
 * Any required folder that is missing or a link yields nothing at all.
 */
export async function gitCommitPaths(gitDirectory: string, common: string): Promise<string[]> {
  const required = [gitDirectory, join(common, 'objects'), join(common, 'refs')];
  try {
    for (const path of required) await directory(path);
  } catch {
    return [];
  }
  const logs = await directory(join(common, 'logs')).catch(() => undefined);
  return [...required, ...(logs ? [logs] : [])];
}

type GitLayout =
  | { kind: 'main' }
  | { kind: 'none' }
  | { kind: 'linked'; gitDirectory: string; commonDirectory: string; checkoutDirectory: string };

/** Undefined: no `.git`, or a form we cannot trust, so Git decides. A missing `commondir` is not a linked worktree. */
async function filesystemGitLayout(cwd: string): Promise<GitLayout | undefined> {
  const dotGit = join(cwd, '.git');
  const dot = await lstat(dotGit).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!dot || dot.isSymbolicLink()) return undefined;
  if (dot.isDirectory()) return { kind: 'main' };
  if (!dot.isFile()) return undefined;
  const gitdir = /^gitdir:\s*(\S(?:.*\S)?)\s*$/.exec((await readFile(dotGit, 'utf8')).split(/\r?\n/, 1)[0] ?? '')?.[1];
  if (!gitdir) return undefined;
  const gitDirectory = resolve(cwd, gitdir);
  const commonStat = await lstat(join(gitDirectory, 'commondir')).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (commonStat === null) return { kind: 'none' };
  if (!commonStat.isFile()) return undefined;
  const commonText = (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim();
  if (!commonText) return undefined;
  return {
    kind: 'linked',
    gitDirectory,
    commonDirectory: resolve(gitDirectory, commonText),
    checkoutDirectory: cwd,
  };
}

const unsafeGitDirectory = '仓库的 Git 目录不在安全位置，未操作。';

/** Common dir from the checkout files and the batch-1 ownership checks, never from `rev-parse`. */
export async function hostRepositoryCommon(path: string, signal?: AbortSignal): Promise<string> {
  const cwd = await directory(path);
  stop(signal);
  const layout = await filesystemGitLayout(cwd);
  if (layout?.kind === 'main') return realpath(join(cwd, '.git'));
  if (layout?.kind !== 'linked') throw new Error(unsafeGitDirectory);
  const inspected = await inspectGitWritePaths(cwd, signal);
  if (!inspected.paths.length) throw new Error(unsafeGitDirectory);
  return realpath(layout.commonDirectory);
}

/** Real common dir, refused when the executor can write it or it sits in the temp directory. */
export async function assertPublishCommon(common: string, project: string, gitWritePaths: string[]): Promise<string> {
  const commonReal = await realpath(common).catch(() => undefined);
  const projectReal = await realpath(project).catch(() => undefined);
  if (!commonReal || !projectReal) throw new Error(unsafeGitDirectory);
  const temp = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const mainGit = await realpath(join(projectReal, '.git')).catch(() => undefined);
  const allowedMain = !!mainGit && samePath(commonReal, mainGit);
  if (
    samePath(temp, commonReal) ||
    inside(temp, commonReal) ||
    (!allowedMain && (samePath(projectReal, commonReal) || inside(projectReal, commonReal)))
  )
    throw new Error(unsafeGitDirectory);
  for (const root of gitWritePaths) {
    const real = await realpath(root).catch(() => undefined);
    if (real && (samePath(real, commonReal) || inside(real, commonReal))) throw new Error(unsafeGitDirectory);
  }
  return commonReal;
}

/** Paths for a linked worktree; a main checkout (Git directory is the common directory) gets none. */
export async function inspectGitWritePaths(
  path: string,
  signal?: AbortSignal,
): Promise<{ paths: string[]; mainCheckout: boolean }> {
  try {
    const cwd = await directory(path);
    stop(signal);
    const located = await filesystemGitLayout(cwd);
    if (located?.kind === 'main') return { paths: [], mainCheckout: true };
    if (located?.kind === 'none') return { paths: [], mainCheckout: false };
    const [gitDirectory, commonDirectory, checkoutDirectory] =
      located?.kind === 'linked'
        ? [located.gitDirectory, located.commonDirectory, located.checkoutDirectory]
        : (
            await gitText(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], {
              signal,
            })
          ).split(/\r?\n/);
    if (!gitDirectory || !commonDirectory || !checkoutDirectory) return { paths: [], mainCheckout: false };
    const common = await realpath(resolve(cwd, commonDirectory));
    const real = await realpath(gitDirectory);
    if (samePath(real, common)) return { paths: [], mainCheckout: true };
    if (!samePath(dirname(real), join(common, 'worktrees'))) return { paths: [], mainCheckout: false };
    const checkout = await realpath(checkoutDirectory);
    const backPointer = (await readOptional(join(real, 'gitdir')))?.toString().trim();
    if (!backPointer || !samePath(await realpath(backPointer), join(checkout, '.git')))
      return { paths: [], mainCheckout: false };
    return { paths: await gitCommitPaths(real, common), mainCheckout: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { paths: [], mainCheckout: false };
  }
}

export async function isGitDirectory(path: string, signal?: AbortSignal): Promise<boolean> {
  const cwd = await directory(path);
  const metadataExists = async (file: string) => {
    try {
      await lstat(file);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  };
  // Plain directories must remain usable without Git installed. Any repository marker still requires Git.
  const norm = (value: string) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  const start = norm(cwd);
  const ceilings = new Set<string>();
  for (const candidate of [resolve(tmpdir()), await realpath(tmpdir()).catch(() => resolve(tmpdir()))]) {
    const comp = norm(candidate);
    if (start.startsWith(comp + sep)) ceilings.add(comp);
  }
  for (let ancestor = cwd; ; ancestor = dirname(ancestor)) {
    stop(signal);
    if (ceilings.has(norm(ancestor))) return false;
    if (
      (await metadataExists(join(ancestor, '.git'))) ||
      ((await metadataExists(join(ancestor, 'HEAD'))) && (await metadataExists(join(ancestor, 'objects'))))
    )
      break;
    const parent = dirname(ancestor);
    if (parent === ancestor || ceilings.has(norm(parent))) return false;
  }
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { signal, allowFailure: true });
  if (!result.code) {
    if (result.stdout.toString().trim() === 'true') return true;
    throw new Error('Git repository has no working tree; isolated children require a checked-out repository.');
  }
  throw new Error(`Cannot inspect Git workspace: ${result.stderr.trim()}`);
}
async function repo(path: string, signal?: AbortSignal): Promise<Repo> {
  const cwd = await directory(path);
  const root = await directory(await gitText(cwd, ['rev-parse', '--show-toplevel'], { signal }));
  if (!samePath(root, cwd))
    throw new Error('Isolated children currently require a project at its Git repository root.');
  const common = await realpath(resolve(root, await gitText(root, ['rev-parse', '--git-common-dir'], { signal })));
  const head = await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}'], { signal });
  const index = resolve(root, await gitText(root, ['rev-parse', '--git-path', 'index'], { signal }));
  const format = await gitText(root, ['rev-parse', '--show-object-format'], { signal });
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unsupported Git object format.');
  return { directory: root, common, head, index, format };
}
function objectId(bytes: Buffer, format: Repo['format']) {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function treeEntries(bytes: Buffer): Entry[] {
  return bytes
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!match || !['100644', '100755'].includes(match[1]!))
        throw new Error('Managed snapshots do not support symbolic links or submodules.');
      validFile(match[3]!);
      return { path: match[3]!, mode: match[1]!, oid: match[2]!, hash: '' };
    });
}
async function tree(cwd: string, revision: string, signal?: AbortSignal) {
  return treeEntries((await git(cwd, ['ls-tree', '-rz', '--full-tree', revision], { signal })).stdout);
}
async function blobs(cwd: string, entries: Entry[], signal?: AbortSignal) {
  const ids = [...new Set(entries.map((entry) => entry.oid))];
  const result = new Map<string, Buffer>();
  if (!ids.length) return result;
  if (ids.some((id) => !/^[a-f0-9]{40,64}$/.test(id))) throw new Error('Invalid snapshot object identifier.');
  const bytes = (await git(cwd, ['cat-file', '--batch'], { input: ids.join('\n') + '\n', signal })).stdout;
  let cursor = 0,
    total = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, cursor);
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(bytes.subarray(cursor, end).toString());
    const size = Number(match?.[2]);
    if (
      end < 0 ||
      match?.[1] !== id ||
      !Number.isSafeInteger(size) ||
      size > limits.file ||
      (total += size) > limits.bytes ||
      end + size + 1 >= bytes.length ||
      bytes[end + size + 1] !== 10
    )
      throw new Error('Invalid or oversized snapshot blob batch.');
    result.set(id, bytes.subarray(end + 1, end + 1 + size));
    cursor = end + size + 2;
  }
  if (cursor !== bytes.length) throw new Error('Unexpected snapshot blob data.');
  return result;
}
/** Only individual ordinary files created for this operation may be removed. Never recurse. */
async function discardScratch(home: string, operation: string, names: string[]) {
  if (!inside(home, operation) || samePath(home, operation)) throw new Error('Scratch path escapes its workspace.');
  await directory(home);
  await directory(operation);
  for (const name of names) {
    const path = await checkedFile(operation, name);
    if (await readOptional(path)) await unlink(path);
  }
  await directory(operation);
  await rmdir(operation);
}
async function scan(r: Repo, signal?: AbortSignal) {
  const entries = await tree(r.directory, r.head, signal);
  const modes = new Map(entries.map((entry) => [entry.path, entry.mode]));
  const staged = (await git(r.directory, ['ls-files', '--stage', '-z'], { signal })).stdout.toString().split('\0');
  for (const line of staged.filter(Boolean)) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] !== '0')
      throw new Error('Resolve the source index conflicts before creating an isolated child.');
    if (!['100644', '100755'].includes(match[1]!))
      throw new Error('Symbolic links and submodules need explicit handling.');
    modes.set(match[3]!, match[1]!);
  }
  const untracked = (await git(r.directory, ['ls-files', '--others', '--exclude-standard', '-z'], { signal })).stdout
    .toString()
    .split('\0')
    .filter(Boolean);
  for (const path of untracked) if (!modes.has(path)) modes.set(path, '100644');
  if (modes.size > limits.files) throw new Error(`Workspace snapshot exceeds ${limits.files} files.`);
  const captured: { entry: Entry; bytes: Buffer }[] = [];
  let total = 0;
  const folded = new Set<string>();
  for (const [path, indexedMode] of [...modes].sort(([a], [b]) => a.localeCompare(b))) {
    stop(signal);
    if (folded.has(path.toLowerCase())) throw new Error(`Case-colliding workspace path: ${path}`);
    folded.add(path.toLowerCase());
    const full = await checkedFile(r.directory, path);
    let stat;
    try {
      stat = await lstat(full);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (!stat.isFile()) throw new Error(`Snapshot requires an ordinary file: ${path}`);
    if (stat.size > limits.file || total + stat.size > limits.bytes)
      throw new Error('Workspace snapshot exceeds its byte limit.');
    const bytes = await readSnapshotFile(full);
    if (bytes.length > limits.file || (total += bytes.length) > limits.bytes)
      throw new Error('Workspace snapshot exceeds its byte limit.');
    const mode = process.platform === 'win32' ? indexedMode : stat.mode & 0o111 ? '100755' : '100644';
    captured.push({ entry: { path, mode, oid: objectId(bytes, r.format), hash: digest(bytes) }, bytes });
  }
  return captured;
}

/** Owns only its recorded directories and refs. */
export class ManagedWorktrees {
  readonly root: string;
  constructor(storageRoot: string) {
    // Links above the storage root belong to the system (macOS /var); from the root down they stay refused.
    this.root = resolve(trustedDirectory(storageRoot));
  }
  /**
   * A project folder given from outside, with system links above it resolved (macOS /tmp, /var). A folder inside
   * this manager's root (a child checkout used as a parent), in either spelling, is never resolved: a link there
   * must still be refused.
   */
  private given(path: string) {
    const resolved = trustedDirectory(path);
    return inside(this.root, resolve(path)) || inside(this.root, resolve(resolved)) ? path : resolved;
  }
  private home(id: string) {
    validId(id);
    return join(this.root, id);
  }
  private async owned(id: string) {
    const home = this.home(id);
    await noLinks(home);
    await mkdir(home, { recursive: true });
    if (!inside(await directory(this.root), await directory(home)))
      throw new Error('Workspace ownership path changed.');
    return home;
  }
  private async read(id: string): Promise<ManagedWorktree | undefined> {
    const home = this.home(id);
    await noLinks(home);
    const bytes = await readOptional(join(home, 'workspace.json'));
    if (!bytes) return;
    const value = JSON.parse(bytes.toString()) as ManagedWorktree;
    if (
      value.version !== 1 ||
      value.id !== id ||
      !samePath(value.directory, join(home, 'checkout')) ||
      (value.mode !== undefined && value.mode !== 'snapshot' && value.mode !== 'branch') ||
      (value.mode !== 'branch' && value.branch !== `codex/managed-${id}`) ||
      !isAbsolute(value.sourceDirectory) ||
      !isAbsolute(value.repositoryCommonDirectory)
    )
      throw new Error('Invalid managed workspace ownership record.');
    validBranch(value.branch);
    if (value.baseCommit) validCommit(value.baseCommit);
    return value;
  }
  private async save(record: ManagedWorktree) {
    record.updatedAt = new Date().toISOString();
    await jsonWrite(join(this.home(record.id), 'workspace.json'), record);
  }
  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = this.home(id).toLowerCase();
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        const home = await this.owned(id);
        const path = join(home, 'operation.lock');
        const recoveryPath = join(home, 'recovery.lock');
        const token = `${process.pid}:${randomUUID()}`;
        let lock;
        let recoveryLock;
        if (await readOptional(recoveryPath))
          throw new Error('Workspace lock recovery is in progress or requires inspection.');
        try {
          lock = await open(path, 'wx');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const old = (await readOptional(path))?.toString();
          const pid = Number(old?.split(':')[0]);
          if (!Number.isSafeInteger(pid) || pid <= 0)
            throw new Error('Invalid workspace operation lock; retained for recovery.');
          try {
            process.kill(pid, 0);
            throw new Error('Workspace operation is already running.');
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
          }
          // Serialize stale-lock reclamation so a second process cannot unlink the first process's new lock.
          recoveryLock = await open(recoveryPath, 'wx');
          await recoveryLock.writeFile(token);
          try {
            await noLinks(path);
            if ((await readOptional(path))?.toString() !== old) throw new Error('Workspace lock changed.');
            await unlink(path);
            lock = await open(path, 'wx');
          } catch (failure) {
            await recoveryLock.close();
            await noLinks(recoveryPath);
            if ((await readOptional(recoveryPath))?.toString() === token) await unlink(recoveryPath);
            throw failure;
          }
        }
        await lock.writeFile(token);
        await lock.sync();
        await lock.close();
        try {
          if (recoveryLock) {
            await recoveryLock.close();
            await noLinks(recoveryPath);
            if ((await readOptional(recoveryPath))?.toString() === token) await unlink(recoveryPath);
          } else if (await readOptional(recoveryPath)) throw new Error('Workspace lock changed during recovery.');
          return await operation();
        } finally {
          await noLinks(path);
          if ((await readOptional(path))?.toString() === token) await unlink(path);
        }
      });
    queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (queues.get(key) === pending) queues.delete(key);
    }
  }
  private async snapshot(r: Repo, home: string, signal?: AbortSignal): Promise<Snapshot> {
    const beforeIndex = await readOptional(r.index);
    const first = await scan(r, signal);
    const second = await scan(r, signal);
    const evidence = (files: typeof first) => JSON.stringify(files.map((file) => file.entry));
    if (
      evidence(first) !== evidence(second) ||
      (await gitText(r.directory, ['rev-parse', 'HEAD'], { signal })) !== r.head ||
      digest((await readOptional(r.index)) ?? Buffer.alloc(0)) !== digest(beforeIndex ?? Buffer.alloc(0))
    )
      throw new Error('Source changed during snapshot; retained without launching a child.');
    const operation = join(home, `snapshot-${randomUUID()}`);
    await mkdir(operation);
    const paths: string[] = [];
    for (let i = 0; i < first.length; i++) {
      const path = join(operation, String(i));
      await writeFile(path, first[i]!.bytes, { flag: 'wx' });
      paths.push(path);
    }
    if (paths.length) {
      const hashes = (
        await gitText(r.directory, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
          input: paths.map((path) => JSON.stringify(path.replaceAll('\\', '/'))).join('\n') + '\n',
          signal,
        })
      ).split('\n');
      if (hashes.some((hash, i) => hash !== first[i]?.entry.oid) || hashes.length !== first.length)
        throw new Error('Snapshot object verification failed.');
    }
    const index = join(operation, 'index');
    await git(r.directory, ['read-tree', '--empty'], { index, signal });
    await git(r.directory, ['update-index', '-z', '--index-info'], {
      index,
      input: first.map(({ entry }) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join(''),
      signal,
    });
    const tree = await gitText(r.directory, ['write-tree'], { index, signal });
    const snapshot = { head: r.head, tree, entries: first.map((file) => file.entry) };
    // Keep immutable recovery objects reachable; only temporary raw copies and the private index are discarded.
    await git(r.directory, ['update-ref', `refs/pugport/workspaces/${basename(home)}/snapshots/${tree}`, tree], {
      signal,
    });
    const evidenceRoot = join(home, 'snapshots');
    await noLinks(evidenceRoot);
    await mkdir(evidenceRoot, { recursive: true });
    await jsonWrite(join(evidenceRoot, `${tree}.json`), snapshot);
    await discardScratch(home, operation, [...paths.map((path) => basename(path)), 'index']);
    return snapshot;
  }
  async prepare(input: PrepareManagedWorktree, signal?: AbortSignal): Promise<ManagedWorktree> {
    if (input.mode !== undefined && input.mode !== 'snapshot' && input.mode !== 'branch')
      throw new Error('Invalid managed workspace mode.');
    if (input.mode !== 'branch' && (input.baseCommit !== undefined || input.branch !== undefined))
      throw new Error('A base commit or branch name requires branch workspace mode.');
    if (input.baseCommit !== undefined) validCommit(input.baseCommit);
    if (input.branch !== undefined) validBranch(input.branch);
    return this.locked(input.id, async () => {
      const existing = await this.read(input.id);
      const source = await repo(this.given(input.sourceDirectory), signal);
      if (inside(source.directory, this.root))
        throw new Error('Managed workspace storage must be outside the source checkout.');
      if (existing) {
        if (
          existing.projectId !== input.projectId ||
          existing.ownerWorkflowId !== input.ownerWorkflowId ||
          existing.parentWorkflowId !== input.parentWorkflowId ||
          (existing.mode ?? 'snapshot') !== (input.mode ?? 'snapshot') ||
          (input.baseCommit !== undefined && existing.baseCommit !== input.baseCommit) ||
          (input.branch !== undefined && existing.branch !== input.branch) ||
          !samePath(existing.sourceDirectory, source.directory) ||
          !samePath(existing.repositoryCommonDirectory, source.common)
        )
          throw new Error('Managed workspace identifier already belongs to a different task or parent.');
        return this.recoverUnlocked(existing, signal);
      }
      const home = this.home(input.id);
      const record: ManagedWorktree = {
        ...input,
        version: 1,
        sourceDirectory: source.directory,
        repositoryCommonDirectory: source.common,
        sourceHead: source.head,
        directory: join(home, 'checkout'),
        mode: input.mode ?? 'snapshot',
        branch: input.branch ?? `codex/managed-${input.id}`,
        state: 'preparing',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.save(record);
      try {
        if (record.mode === 'branch') {
          record.symlinkMode = await branchSymlinkMode(source.directory, signal);
          const commit = input.baseCommit ?? source.head;
          validCommit(commit);
          const resolved = await resolveLaneBase(source.directory, commit, signal);
          if (resolved !== commit)
            throw new LaneWorkspaceValidationError('The selected object is not a commit in the source repository.');
          await git(source.directory, ['check-ref-format', '--branch', record.branch], { signal });
          record.baseCommit = commit;
          record.baseTree = await gitText(source.directory, ['rev-parse', `${commit}^{tree}`], { signal });
          await this.save(record);
          return await this.recoverUnlocked(record, signal);
        }
        const snapshot = await this.snapshot(source, home, signal);
        record.baseTree = snapshot.tree;
        record.baseCommit = await gitText(
          source.directory,
          ['commit-tree', snapshot.tree, '-p', source.head, '-m', `PugPort managed child ${input.id}`],
          { signal },
        );
        await this.save(record);
        return await this.recoverUnlocked(record, signal);
      } catch (error) {
        record.state = 'failed';
        record.error = String(error);
        await this.save(record);
        throw error;
      }
    });
  }
  private async verify(record: ManagedWorktree, signal?: AbortSignal) {
    const child = await repo(record.directory, signal);
    if (!samePath(child.common, record.repositoryCommonDirectory))
      throw new Error('Child repository identity changed.');
    const branch = await gitText(child.directory, ['symbolic-ref', '--quiet', 'HEAD'], { signal });
    if (branch !== `refs/heads/${record.branch}`) throw new Error('Child checkout no longer uses its owned branch.');
    const ancestry = await git(child.directory, ['merge-base', '--is-ancestor', record.baseCommit!, 'HEAD'], {
      signal,
      allowFailure: true,
    });
    if (ancestry.code) throw new Error('Child checkout no longer descends from the recorded source snapshot.');
    if (record.mode === 'branch') {
      const paths = await this.branchGitPaths(record, signal);
      if (
        record.gitDirectory !== undefined &&
        (!samePath(record.gitDirectory, paths.gitDirectory) ||
          JSON.stringify(record.gitWritePaths) !== JSON.stringify(paths.gitWritePaths))
      )
        throw new Error('Managed branch Git administration paths changed.');
    }
    return child;
  }
  private async branchGitPaths(record: ManagedWorktree, signal?: AbortSignal) {
    const common = await directory(record.repositoryCommonDirectory);
    const gitDirectory = await directory(
      await gitText(record.directory, ['rev-parse', '--absolute-git-dir'], { signal }),
    );
    if (!inside(join(common, 'worktrees'), gitDirectory) || samePath(join(common, 'worktrees'), gitDirectory))
      throw new Error('Child Git administration directory is outside the owned worktree registration.');
    const backPointer = (await readOptional(join(gitDirectory, 'gitdir')))?.toString().trim();
    if (!backPointer || !samePath(backPointer, join(record.directory, '.git')))
      throw new Error('Child Git registration points to a different checkout.');
    const branchRef = join(common, 'refs', 'heads', ...record.branch.split('/'));
    const branchLog = join(common, 'logs', 'refs', 'heads', ...record.branch.split('/'));
    const gitWritePaths = [
      gitDirectory,
      join(common, 'objects'),
      branchRef,
      `${branchRef}.lock`,
      branchLog,
      `${branchLog}.lock`,
    ];
    for (const path of gitWritePaths) await noLinks(path);
    return { gitDirectory, gitWritePaths };
  }
  private async recoverBranch(record: ManagedWorktree, source: Repo, signal?: AbortSignal) {
    let present = true;
    try {
      await lstat(record.directory);
    } catch (error) {
      if (!missing(error)) throw error;
      present = false;
    }
    if (!present) {
      await assertLaneBranchAvailable(source.directory, record.branch, signal);
      // Checkout must not execute repository-defined filters, even when attributes name one.
      const overrides = await disabledFilters(source.directory, signal);
      const added = await git(
        source.directory,
        [
          ...overrides,
          '-c',
          `core.symlinks=${record.symlinkMode === 'native'}`,
          'worktree',
          'add',
          '--lock',
          '--reason',
          `PugPort managed child ${record.id}`,
          '-b',
          record.branch,
          record.directory,
          record.baseCommit!,
        ],
        { signal, timeoutMs: 120000, allowFailure: true },
      );
      if (added.code) {
        // A failed checkout can have created its branch; only explicit ref conflicts permit rollback.
        if (/a branch named .* already exists|cannot lock ref .*reference already exists/.test(added.stderr))
          throw new LaneWorkspaceValidationError(added.stderr.trim());
        throw new Error(added.stderr.trim() || 'Git worktree add failed.');
      }
    }
    await this.verify(record, signal);
    // A partial checkout is never repaired with reset/checkout: it may contain user work.
    if (
      present &&
      (await gitText(
        record.directory,
        [...(await disabledFilters(record.directory, signal)), 'status', '--porcelain=v1', '--untracked-files=normal'],
        { signal },
      ))
    )
      throw new Error('Incomplete branch checkout contains changes; retained for inspection without overwriting work.');
    Object.assign(record, await this.branchGitPaths(record, signal));
    await this.linkDependencies(record, source, signal);
    record.state = 'ready';
    delete record.error;
    await this.save(record);
    return record;
  }
  private async linkDependencies(record: ManagedWorktree, source: Repo, signal?: AbortSignal) {
    if (record.dependencyPreparationPath) {
      validFile(record.dependencyPreparationPath);
      throw new Error(
        `Dependency preparation incomplete at ${record.dependencyPreparationPath}; retained for inspection.`,
      );
    }
    const tracked = await git(source.directory, ['ls-files', '--cached', '-z'], { signal });
    for (const manifest of new Set(tracked.stdout.toString().split('\0'))) {
      if (basename(manifest) !== 'package.json') continue;
      const path = [...manifest.split('/').slice(0, -1), 'node_modules'].join('/');
      validFile(path);
      const target = join(source.directory, path);
      await noLinks(dirname(target));
      try {
        if (!(await stat(target)).isDirectory()) continue;
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      const ignored = await git(source.directory, ['check-ignore', '-q', '--', path], { signal, allowFailure: true });
      if (ignored.code === 1) continue;
      if (ignored.code) throw new Error('Cannot inspect dependency ignore rules.');
      const link = join(record.directory, path);
      await noLinks(dirname(link));
      try {
        await lstat(link);
        continue;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      record.dependencyPreparationPath = path;
      await this.save(record);
      await mkdir(dirname(link), { recursive: true });
      await mkdir(link);
      const childIgnored = await git(record.directory, ['check-ignore', '-q', '--', path], {
        signal,
        allowFailure: true,
      });
      if (childIgnored.code > 1) throw new Error('Cannot inspect child dependency ignore rules.');
      if (childIgnored.code === 1) {
        // Older base commits may lack the source's dependency ignore rules.
        const exclude = join(record.repositoryCommonDirectory, 'info', 'exclude');
        await noLinks(exclude);
        const contents = (await readOptional(exclude))?.toString('utf8') ?? '';
        const rule = `/${path.replace(/[!*?[\]\\]/g, '\\$&')}`;
        if (!contents.split(/\r?\n/).includes(rule)) {
          await mkdir(dirname(exclude), { recursive: true });
          await appendFile(exclude, `\n${rule}\n`);
        }
      }
      const links: { path: string; target: string }[] = [];
      const populate = async (from: string, to: string, containers: boolean) => {
        for (const entry of await readdir(from)) {
          stop(signal);
          const destination = `${to}/${entry}`;
          validFile(destination);
          const resolved = await realpath(join(from, entry));
          const info = await stat(resolved);
          if (info.isDirectory()) {
            if (containers && (entry.startsWith('@') || entry === '.pnpm')) {
              await mkdir(join(record.directory, destination));
              await populate(resolved, destination, false);
            } else links.push({ path: destination, target: resolved });
          } else if (info.isFile()) {
            await writeFile(join(record.directory, destination), await readSnapshotFile(resolved), { flag: 'wx' });
          }
        }
      };
      await populate(target, path, true);
      record.linkedDependencyPaths = [
        ...new Set([...(record.linkedDependencyPaths ?? []), ...links.map((l) => l.path)]),
      ];
      await this.save(record);
      // shortcut: in-place edits inside linked packages still change the source; use copies if write isolation is needed.
      for (const dependency of links) {
        stop(signal);
        const destination = join(record.directory, dependency.path);
        await noLinks(dirname(destination));
        await symlink(dependency.target, destination, process.platform === 'win32' ? 'junction' : 'dir');
      }
      delete record.dependencyPreparationPath;
      await this.save(record);
    }
  }
  async forgetFailedPreparation(id: string): Promise<boolean> {
    return this.locked(id, async () => {
      const record = await this.read(id);
      if (!record) return true;
      if (record.mode !== 'branch' || record.state !== 'failed') return false;
      try {
        await lstat(record.directory);
        return false;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      // Forget metadata only; an existing branch or worktree may belong to another caller.
      await unlink(join(this.home(id), 'workspace.json'));
      return true;
    });
  }
  async release(
    id: string,
    options: { stillWanted: () => boolean; signal?: AbortSignal },
  ): Promise<ManagedWorktreeRelease> {
    const result = await this.locked(id, async (): Promise<ManagedWorktreeRelease> => {
      const record = await this.read(id);
      if (!record) return { status: 'kept', reason: '没有受管记录。' };
      if (record.mode !== 'branch') return { status: 'kept', reason: '不是独立分支工作线，目录已保留。' };
      const { signal } = options;
      // read() requires the exact checkout under this owned home.
      const common = await directory(record.repositoryCommonDirectory);
      let exists = true;
      try {
        await lstat(record.directory);
      } catch (error) {
        if (!missing(error)) throw error;
        exists = false;
      }
      let head: string;
      let ignored = 0;
      if (exists) {
        const child = await this.verify(record, signal);
        const filters = await disabledFilters(record.directory, signal);
        const status = await gitText(
          record.directory,
          [...filters, 'status', '--porcelain=v1', '--untracked-files=normal'],
          { signal },
        );
        if (status)
          return { status: 'kept', reason: `有未提交或未跟踪文件：${status.slice(0, 500)}`, branch: record.branch };
        const ignoredStatus = await gitText(
          record.directory,
          [...filters, 'status', '--porcelain=v1', '--ignored=matching'],
          { signal },
        );
        ignored = ignoredStatus.split(/\r?\n/).filter((line) => line.startsWith('!! ')).length;
        head = child.head;
      } else {
        const paths = (await gitText(common, ['worktree', 'list', '--porcelain', '-z'], { signal })).split('\0');
        const registered = paths.some(
          (line) => line.startsWith('worktree ') && samePath(line.slice(9), record.directory),
        );
        return {
          status: 'kept',
          reason: '工作目录不存在，保留注册和分支以供检查。',
          branch: record.branch,
          ...(!registered ? { detached: true } : {}),
        };
      }
      const refs = (await gitText(common, ['branch', '--all', '--contains', head, '--format=%(refname)'], { signal }))
        .split(/\r?\n/)
        .filter((ref) => ref && ref !== `refs/heads/${record.branch}`);
      if (!refs.length)
        return { status: 'kept', reason: `HEAD ${head.slice(0, 7)} 未推送/未合并。`, branch: record.branch, head };
      if (!options.stillWanted())
        return { status: 'kept', reason: '工作线不再处于归档且空闲状态。', branch: record.branch, head };
      const unlinked: string[] = [];
      if (exists) {
        unlinked.push(...(await unlinkCheckoutLinks(record.directory, record.linkedDependencyPaths)));
        await git(common, ['worktree', 'unlock', record.directory], { signal, allowFailure: true });
        const removed = await git(common, ['worktree', 'remove', record.directory], {
          signal,
          allowFailure: true,
          timeoutMs: 120000,
        });
        if (removed.code) {
          const paths = (await gitText(common, ['worktree', 'list', '--porcelain', '-z'], { signal })).split('\0');
          const registered = paths.some(
            (line) => line.startsWith('worktree ') && samePath(line.slice(9), record.directory),
          );
          return {
            status: 'kept',
            reason: registered
              ? `git worktree remove：${removed.stderr.trim()}`
              : `目录残留请手删；提交安全在 ${refs.join('、')}。`,
            branch: record.branch,
            head,
            ...(!registered ? { detached: true } : {}),
          };
        }
      }
      const branchHead = await gitText(common, ['rev-parse', '--verify', `refs/heads/${record.branch}^{commit}`], {
        signal,
      });
      // A brief race remains after this check; branch -D, unlike update-ref -d, refuses branches checked out elsewhere.
      const deleted =
        branchHead === head
          ? await git(common, ['branch', '-D', record.branch], { signal, allowFailure: true })
          : { code: 1, stderr: '分支在清理期间发生变化。' };
      await unlink(join(this.home(id), 'delivery.json')).catch(() => undefined);
      await unlink(join(this.home(id), 'workspace.json'));
      const note = [
        ignored ? `清理时包含 ${ignored} 个被忽略的条目。` : '',
        deleted.code ? `分支保留：${deleted.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return {
        status: 'removed',
        branch: record.branch,
        head,
        branchDeleted: !deleted.code,
        unlinked,
        ...(note ? { note } : {}),
      };
    });
    if (result.status === 'removed') await rmdir(this.home(id)).catch(() => undefined);
    return result;
  }
  async inspect(id: string): Promise<ManagedWorktree | undefined> {
    const record = await this.read(id);
    if (!record) return;
    if (record.state === 'ready') {
      try {
        await this.verify(record);
      } catch (error) {
        return { ...record, state: 'recovery-required', error: String(error) };
      }
    }
    return this.recoveryView(record);
  }
  private async recoveryView(record: ManagedWorktree) {
    const bytes = await readOptional(join(this.home(record.id), 'delivery.json'));
    const journal = bytes ? (JSON.parse(bytes.toString()) as Journal) : undefined;
    if (journal?.state === 'applying' && record.lastApplied?.childTree !== journal.childTree)
      return {
        ...record,
        delivery: {
          ...record.delivery,
          status: 'recovery-required' as const,
          at: record.delivery?.at ?? record.updatedAt,
          changedPaths: journal.changes.map((item) => item.path),
          reason: 'Interrupted delivery retained; explicitly retry after reviewing the parent workspace.',
        },
      };
    return record;
  }
  async recover(id: string): Promise<ManagedWorktree> {
    return this.locked(id, async () => {
      const record = await this.read(id);
      if (!record) throw new Error('Managed workspace record is missing.');
      return this.recoverUnlocked(record);
    });
  }
  /** Serialize a host publish with other operations on this managed lane. */
  async withLaneLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.locked(id, operation);
  }
  /** Caller holds the child's physical execution lease and checks current owner/write authorization. */
  async commitBranch(id: string, options: CommitManagedBranch, signal?: AbortSignal): Promise<ManagedBranchCommit> {
    if (
      typeof options.message !== 'string' ||
      !options.message.trim() ||
      options.message.length > 65536 ||
      options.message.includes('\0')
    )
      throw new Error('A nonempty commit message of at most 65536 characters is required.');
    if (
      options.paths !== undefined &&
      (!Array.isArray(options.paths) || !options.paths.length || options.paths.length > 1000)
    )
      throw new Error('Commit paths must be a nonempty list of at most 1000 literal paths.');
    for (const path of options.paths ?? []) validFile(path);
    return this.locked(id, async () => {
      let record = await this.read(id);
      if (!record || record.mode !== 'branch')
        throw new Error('Only an owned branch workspace can create a branch commit.');
      record = await this.recoverUnlocked(record, signal);
      if (record.state !== 'ready') throw new Error('Managed branch workspace is not ready.');
      const child = await this.verify(record, signal);
      for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
        try {
          await lstat(join(record.gitDirectory!, marker));
          throw new Error('Finish or abort the existing Git operation before committing this branch.');
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      const filters = await disabledFilters(child.directory, signal);
      const paths = options.paths?.map((path) => `:(literal)${path}`) ?? ['.'];
      const listed = await git(
        child.directory,
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...paths],
        { signal },
      );
      for (const path of new Set(listed.stdout.toString().split('\0').filter(Boolean))) {
        validFile(path);
        await noLinks(dirname(join(child.directory, path)));
      }
      for (const path of options.paths ?? []) await noLinks(dirname(join(child.directory, path)));
      // Do not resolve a merge or record another repository's submodule state through this endpoint.
      if ((await git(child.directory, ['ls-files', '--unmerged', '-z'], { signal })).stdout.length)
        throw new Error('Resolve the child index conflicts before committing.');
      const selectedIndex = await git(child.directory, ['ls-files', '--stage', '-z', '--', ...paths], { signal });
      if (
        selectedIndex.stdout
          .toString()
          .split('\0')
          .some((line) => line.startsWith('160000 '))
      )
        throw new Error('Submodule changes require separate review and are not committed by this endpoint.');
      const operation = join(this.home(id), `commit-${randomUUID()}`);
      await mkdir(operation);
      const index = join(operation, 'index'),
        nextIndex = join(operation, 'next-index');
      const lockPath = `${child.index}.lock`;
      await noLinks(lockPath);
      const indexLock = await open(lockPath, 'wx');
      let lockOpen = true,
        lockOwned = true,
        committed: string | undefined;
      try {
        const originalIndex = await readOptional(child.index);
        await git(child.directory, ['read-tree', child.head], { index, signal });
        const symlinkMode = record.symlinkMode ?? (await branchSymlinkMode(child.directory, signal));
        await git(
          child.directory,
          [...filters, '-c', `core.symlinks=${symlinkMode === 'native'}`, 'add', '-A', '--', ...paths],
          {
            index,
            signal,
            timeoutMs: 120000,
          },
        );
        // Writing an index that `add` just filled re-reads racily clean files, which runs their filters again
        // (seen with the fine-grained file times on macOS), so the filters stay off here too.
        const nextTree = await gitText(child.directory, [...filters, 'write-tree'], { index, signal });
        const changedPaths = (
          await git(
            child.directory,
            ['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', child.head, nextTree],
            { signal },
          )
        ).stdout
          .toString()
          .split('\0')
          .filter(Boolean);
        const scope = options.scope && normalizeScope(options.scope);
        for (const path of changedPaths) {
          validFile(path);
          await noLinks(dirname(join(child.directory, path)));
          if (scope && !withinScope(path, scope))
            throw new Error('Branch commit changes exceed the inherited file scope.');
        }
        if (!changedPaths.length)
          return { status: 'unchanged', commit: child.head, branch: record.branch, changedPaths };
        const identityValue = async (key: string) => {
          const result = await git(child.directory, ['config', '--get', key], {
            readUserConfig: true,
            allowFailure: true,
            signal,
          });
          const value = result.stdout.toString().trim();
          if (result.code || !value || value.length > 320 || /[\x00-\x1f<>]/.test(value))
            throw new Error('Configure a valid Git user.name and user.email before committing this branch.');
          return value;
        };
        const identity = { name: await identityValue('user.name'), email: await identityValue('user.email') };
        if (originalIndex) await writeFile(nextIndex, originalIndex, { flag: 'wx' });
        else await git(child.directory, ['read-tree', child.head], { index: nextIndex, signal });
        const selected = await git(child.directory, ['ls-files', '--stage', '-z'], { index, signal });
        const changed = new Set(changedPaths);
        const entries = selected.stdout
          .toString()
          .split('\0')
          .filter((line) => changed.has(line.slice(line.indexOf('\t') + 1)));
        if (entries.some((line) => line.startsWith('160000 ')))
          throw new Error('Submodule changes require separate review and are not committed by this endpoint.');
        await git(child.directory, ['update-index', '-z', '--index-info'], {
          index: nextIndex,
          signal,
          input:
            changedPaths.map((path) => `0 ${'0'.repeat(child.head.length)}\t${path}\0`).join('') +
            entries.map((line) => `${line}\0`).join(''),
        });
        const commit = await gitText(child.directory, ['commit-tree', nextTree, '-p', child.head, '-F', '-'], {
          input: options.message,
          identity,
          signal,
        });
        await this.verify(record, signal);
        if (digest((await readOptional(child.index)) ?? Buffer.alloc(0)) !== digest(originalIndex ?? Buffer.alloc(0)))
          throw new Error('Child index changed while preparing the branch commit; changes were retained.');
        await indexLock.writeFile(await readFile(nextIndex));
        await indexLock.sync();
        await indexLock.close();
        lockOpen = false;
        stop(signal);
        // Once the ref moves, finish its paired index update even if cancellation arrives.
        await git(
          child.directory,
          [
            'update-ref',
            '--no-deref',
            '-m',
            'PugPort branch commit',
            `refs/heads/${record.branch}`,
            commit,
            child.head,
          ],
          { identity },
        );
        committed = commit;
        await rename(lockPath, child.index);
        lockOwned = false;
        return { status: 'committed', commit, branch: record.branch, changedPaths };
      } catch (error) {
        if (committed)
          throw new Error(
            `Branch commit ${committed} was created; its index update needs inspection. Working files were retained. ${String(error)}`,
          );
        throw error;
      } finally {
        if (lockOpen) await indexLock.close();
        // Only this operation's lock and scratch indexes are removed; never user files or refs.
        if (lockOwned) {
          await noLinks(lockPath);
          if (await readOptional(lockPath)) await unlink(lockPath);
        }
        await discardScratch(this.home(id), operation, ['index', 'index.lock', 'next-index', 'next-index.lock']);
      }
    });
  }
  private async recoverUnlocked(record: ManagedWorktree, signal?: AbortSignal) {
    if (record.state === 'ready') {
      await this.verify(record, signal);
      return this.recoveryView(record);
    }
    if (!record.baseCommit || !record.baseTree)
      throw new Error('Incomplete snapshot retained; create a new child to retry.');
    const source = await repo(record.sourceDirectory, signal);
    if (!samePath(source.common, record.repositoryCommonDirectory))
      throw new Error('Parent repository identity changed.');
    await noLinks(record.directory);
    if (record.mode === 'branch') {
      record.symlinkMode ??= await branchSymlinkMode(source.directory, signal);
      return this.recoverBranch(record, source, signal);
    }
    try {
      await lstat(record.directory);
    } catch (error) {
      if (!missing(error)) throw error;
      const ref = await git(source.directory, ['show-ref', '--verify', '--hash', `refs/heads/${record.branch}`], {
        signal,
        allowFailure: true,
      });
      if (!ref.code && ref.stdout.toString().trim() !== record.baseCommit)
        throw new Error('Owned branch changed before checkout creation.');
      await git(
        source.directory,
        [
          'worktree',
          'add',
          '--no-checkout',
          ...(!ref.code ? [] : ['-b', record.branch]),
          record.directory,
          !ref.code ? record.branch : record.baseCommit,
        ],
        { signal },
      );
    }
    const child = await this.verify(record, signal);
    const entries = await tree(source.directory, record.baseTree, signal);
    const expected = new Map(entries.map((entry) => [entry.path, entry]));
    if (await readOptional(child.index)) {
      const indexed = (await git(child.directory, ['ls-files', '--stage', '-z'], { signal })).stdout
        .toString()
        .split('\0')
        .filter(Boolean);
      if (
        indexed.length !== entries.length ||
        indexed.some((line) => {
          const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(line);
          const baseline = match && expected.get(match[3]!);
          return !baseline || baseline.mode !== match![1] || baseline.oid !== match![2];
        })
      )
        throw new Error('Incomplete checkout contains staged changes; retained without replacing its index.');
    }
    const visit = async (root: string, prefix = '') => {
      for (const item of await readdir(root, { withFileTypes: true })) {
        if (!prefix && item.name === '.git') continue;
        const path = prefix + item.name;
        if (item.isSymbolicLink()) throw new Error('Incomplete checkout contains a link; retained for inspection.');
        if (item.isDirectory()) await visit(join(root, item.name), path + '/');
        else {
          const entry = expected.get(path);
          const bytes = await readFile(await checkedFile(record.directory, path));
          if (!entry || objectId(bytes, source.format) !== entry.oid)
            throw new Error('Incomplete checkout contains new work; retained without overwriting it.');
        }
      }
    };
    await visit(record.directory);
    const contents = await blobs(source.directory, entries, signal);
    for (const entry of entries) {
      stop(signal);
      const path = await checkedFile(record.directory, entry.path);
      if (!(await readOptional(path))) {
        await mkdir(dirname(path), { recursive: true });
        const bytes = contents.get(entry.oid)!;
        await writeFile(path, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
      }
    }
    await git(record.directory, ['read-tree', record.baseCommit], { signal });
    await git(
      source.directory,
      ['worktree', 'lock', '--reason', `PugPort managed child ${record.id}`, record.directory],
      { signal, allowFailure: true },
    );
    record.state = 'ready';
    delete record.error;
    await this.save(record);
    return record;
  }
  /** Caller must hold the direct parent's physical execution lease until this operation returns. */
  async apply(
    id: string,
    options: { parentDirectory: string; scope?: string[] },
    signal?: AbortSignal,
  ): Promise<ManagedWorktreeDelivery> {
    return this.locked(id, async () => {
      const record = await this.read(id);
      if (!record || record.state !== 'ready') throw new Error('Managed child workspace is not ready.');
      if (record.mode === 'branch')
        throw new Error(
          'Independent branch workspaces do not deliver files into the parent; review and integrate the branch separately.',
        );
      const receipt = async (
        status: ManagedWorktreeDelivery['status'],
        reason: string,
        extra: Partial<ManagedWorktreeDelivery> = {},
      ) => {
        record.delivery = { status, reason, at: new Date().toISOString(), changedPaths: [], ...extra };
        await this.save(record);
        return record.delivery;
      };
      try {
        stop(signal);
        const parent = await repo(this.given(options.parentDirectory), signal);
        if (
          !samePath(parent.directory, record.sourceDirectory) ||
          !samePath(parent.common, record.repositoryCommonDirectory)
        )
          return receipt('blocked', 'Delivery target is not the recorded direct parent workspace.');
        const child = await this.verify(record, signal);
        const childSnapshot = await this.snapshot(child, this.home(id), signal);
        const before = await this.snapshot(parent, this.home(id), signal);
        const fromTree = record.lastApplied?.childTree ?? record.baseTree!;
        const base = new Map((await tree(parent.directory, fromTree, signal)).map((entry) => [entry.path, entry]));
        const after = new Map(childSnapshot.entries.map((entry) => [entry.path, entry]));
        const current = new Map(before.entries.map((entry) => [entry.path, entry]));
        const changedPaths = [...new Set([...base.keys(), ...after.keys()])].filter(
          (path) => base.get(path)?.oid !== after.get(path)?.oid || base.get(path)?.mode !== after.get(path)?.mode,
        );
        const journalPath = join(this.home(id), 'delivery.json');
        const pending = await readOptional(journalPath);
        const journal = pending ? (JSON.parse(pending.toString()) as Journal) : undefined;
        const needsRecovery = journal?.state === 'applying' && record.lastApplied?.childTree !== journal.childTree;
        if (needsRecovery && journal.childTree !== childSnapshot.tree)
          return receipt('recovery-required', 'Child changed while an earlier delivery requires recovery.');
        const scope = options.scope && normalizeScope(options.scope);
        if (scope && changedPaths.some((path) => !withinScope(path, scope)))
          return receipt('blocked', 'Child changes exceed its inherited file scope.', {
            changedPaths,
            childTree: childSnapshot.tree,
          });
        if (!changedPaths.length) {
          const previous = record.lastApplied;
          if (
            previous?.changes?.some(
              (change) =>
                current.get(change.path)?.oid !== change.after || current.get(change.path)?.mode !== change.afterMode,
            )
          )
            return receipt(
              'blocked',
              'Parent changed after the previous delivery; the accepted patch was not replayed.',
              { childTree: childSnapshot.tree },
            );
          return receipt('unchanged', 'No undelivered child changes.', {
            childTree: childSnapshot.tree,
            parentBeforeTree: before.tree,
            parentAfterTree: before.tree,
          });
        }
        let planned: Planned[];
        if (needsRecovery) {
          planned = journal.changes;
          if (
            !Array.isArray(planned) ||
            planned.length > limits.files ||
            planned.some((item) => !changedPaths.includes(item.path)) ||
            planned.length !== changedPaths.length
          )
            return receipt('recovery-required', 'Invalid delivery recovery evidence; retained for inspection.');
          if (
            planned.some((item) => {
              const actual = current.get(item.path);
              return !this.equal(actual, item.before) && !this.equal(actual, item.after);
            })
          )
            return receipt(
              'recovery-required',
              'Parent changed during an interrupted delivery; all files and evidence were retained.',
            );
        } else {
          planned = [];
          for (const path of changedPaths) {
            const original = base.get(path),
              proposed = after.get(path),
              actual = current.get(path);
            let merged = proposed;
            if (!this.equal(actual, original) && !this.equal(actual, proposed)) {
              if (
                !actual ||
                !original ||
                !proposed ||
                (actual.mode !== original.mode && proposed.mode !== original.mode && actual.mode !== proposed.mode)
              )
                return receipt('conflict', `Conflicting child and parent changes: ${path}`, {
                  changedPaths,
                  childTree: childSnapshot.tree,
                  parentBeforeTree: before.tree,
                });
              const operation = join(this.home(id), `merge-${randomUUID()}`);
              await mkdir(operation);
              const files = [actual, original, proposed];
              const contents = await blobs(parent.directory, files, signal);
              for (let i = 0; i < files.length; i++)
                await writeFile(join(operation, String(i)), contents.get(files[i]!.oid)!, { flag: 'wx' });
              const result = await git(operation, ['merge-file', '-p', '--diff3', '0', '1', '2'], {
                signal,
                allowFailure: true,
              });
              await discardScratch(this.home(id), operation, ['0', '1', '2']);
              if (result.code)
                return receipt('conflict', `Conflicting child and parent changes: ${path}`, {
                  changedPaths,
                  childTree: childSnapshot.tree,
                  parentBeforeTree: before.tree,
                });
              const oid = await gitText(parent.directory, ['hash-object', '-w', '--no-filters', '--stdin'], {
                input: result.stdout,
                signal,
              });
              merged = {
                path,
                oid,
                hash: digest(result.stdout),
                mode: proposed.mode === original.mode ? actual.mode : proposed.mode,
              };
            }
            planned.push({ path, before: actual, after: merged });
          }
        }
        // Validate every destination before the first write, including link and file/directory collisions.
        for (const item of planned) {
          await readOptional(await checkedFile(parent.directory, item.path));
          if (process.platform === 'win32' && item.after && item.after.mode !== (item.before?.mode ?? '100644'))
            return receipt('blocked', 'Executable mode changes cannot be applied safely on Windows.', { changedPaths });
        }
        const outputs = await blobs(
          parent.directory,
          planned.flatMap((item) => (item.after ? [item.after] : [])),
          signal,
        );
        stop(signal);
        const activeJournal: Journal = {
          state: 'applying',
          childTree: childSnapshot.tree,
          parentBeforeTree:
            journal?.state === 'applying' && record.lastApplied?.childTree !== journal.childTree
              ? journal.parentBeforeTree
              : before.tree,
          changes: planned,
        };
        await jsonWrite(journalPath, activeJournal);
        await receipt('applying', 'Prepared and checked child delivery.', {
          changedPaths,
          childTree: childSnapshot.tree,
          parentBeforeTree: before.tree,
        });
        stop(signal);
        let writesStarted = false;
        const beginWrite = () => {
          if (!writesStarted) stop(signal);
          writesStarted = true;
        };
        // Once writes start, complete this bounded journal even if cancellation arrives; crashes remain recoverable.
        for (const item of planned) {
          const path = await checkedFile(parent.directory, item.path);
          const bytes = await readOptional(path);
          const actualOid = bytes ? objectId(bytes, parent.format) : undefined;
          if (actualOid !== item.before?.oid && actualOid !== item.after?.oid)
            return receipt(
              'recovery-required',
              `Parent changed while applying ${item.path}; retained without overwriting it.`,
            );
          if (actualOid === item.after?.oid) {
            if (item.after && process.platform !== 'win32') {
              beginWrite();
              await chmod(path, item.after.mode === '100755' ? 0o755 : 0o644);
            }
            continue;
          }
          if (!item.after) {
            beginWrite();
            await unlink(path);
          } else {
            beginWrite();
            await mkdir(dirname(path), { recursive: true });
            const output = outputs.get(item.after.oid)!;
            const temp = `${path}.pugport-${randomUUID()}`;
            await writeFile(temp, output, { flag: 'wx', mode: item.after.mode === '100755' ? 0o755 : 0o644 });
            await checkedFile(parent.directory, item.path);
            const latest = await readOptional(path);
            if ((latest ? objectId(latest, parent.format) : undefined) !== actualOid)
              return receipt(
                'recovery-required',
                `Parent changed before replacing ${item.path}; retained both versions.`,
              );
            await rename(temp, path);
            if (process.platform !== 'win32') await chmod(path, item.after.mode === '100755' ? 0o755 : 0o644);
          }
        }
        const final = await this.snapshot(await repo(parent.directory), this.home(id));
        const finalEntries = new Map(final.entries.map((entry) => [entry.path, entry]));
        if (planned.some((item) => !this.equal(finalEntries.get(item.path), item.after)))
          return receipt(
            'recovery-required',
            'Parent changed before delivery verification; recovery evidence retained.',
          );
        const completed: ManagedWorktreeDelivery = {
          status: 'applied',
          at: new Date().toISOString(),
          reason: 'Child changes applied to the recorded parent workspace.',
          changedPaths,
          childTree: childSnapshot.tree,
          parentBeforeTree: activeJournal.parentBeforeTree,
          parentAfterTree: final.tree,
          changes: planned.map((item) => ({
            path: item.path,
            before: item.before?.oid,
            after: item.after?.oid,
            afterMode: item.after?.mode,
          })),
        };
        record.delivery = completed;
        record.lastApplied = completed;
        await this.save(record);
        await jsonWrite(journalPath, { ...activeJournal, state: 'completed' });
        return completed;
      } catch (error) {
        return receipt(record.delivery?.status === 'applying' ? 'recovery-required' : 'blocked', String(error));
      }
    });
  }
  private equal(a?: Entry, b?: Entry) {
    return a?.oid === b?.oid && a?.mode === b?.mode;
  }
}
