import { lstat, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';
import { hostGit, validBranch } from '../managed-worktrees.ts';
import { scanOutbound } from '../github-gate.ts';

export const maxShuttleBytes = 256 * 1024 ** 2;
export const secretNamePattern =
  /(?:^|[/\\])(?:\.env(?:\.(?!(?:example|sample|template|dist)$)[^/\\]*)?|[^/\\]*\.(?:pem|key|p12|pfx|jks|keystore)|\.(?:npmrc|netrc|pypirc)|id_(?:rsa|ed25519)[^/\\]*)$/i;

export type RepositorySnapshot = {
  ok: true;
  top: string;
  root: string;
  subpath: string;
  head: string;
  snapshot: string;
  ref: string;
  bundle: string;
  bytes: number;
  leftOut: string[];
  warnings: string[];
};
const tripRef = (tripId: string) => {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(tripId)) throw new Error('Invalid repository trip ID.');
  return `refs/pugport/shuttle/${tripId}`;
};
const paths = (output: string) => output.split('\0').filter(Boolean);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const tooLarge = (bytes: number) => `项目太大（${Math.ceil(bytes / 1024 ** 2)} MiB），没有带过去`;

export async function snapshotRepository(
  cwd: string,
  tripId: string,
  signal?: AbortSignal,
): Promise<RepositorySnapshot | { ok: false; notRepo?: true; reason: string }> {
  const ref = tripRef(tripId);
  const bundle = join(tmpdir(), `pugport-${tripId}.bundle`);
  let top = '';
  let temporary: string | undefined;
  let pinned = false;
  const git = async (args: string[], options: Parameters<typeof hostGit>[2] = {}) =>
    (await hostGit(top || cwd, args, { readUserConfig: true, signal, ...options })).stdout.trim();
  try {
    const discovered = await hostGit(cwd, ['rev-parse', '--show-toplevel'], {
      readUserConfig: true,
      signal,
      allowFailure: true,
    });
    if (discovered.code) return { ok: false, notRepo: true, reason: '这个文件夹不是 Git 项目。' };
    top = discovered.stdout.trim();
    const home = await realpath(homedir()).catch(() => homedir());
    if (samePath(top, home) || samePath(top, parse(top).root))
      return { ok: false, notRepo: true, reason: '不会把主文件夹或磁盘根目录带到设备上。' };
    const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
    for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
      const path = await git(['rev-parse', '--git-path', name]);
      if (
        await lstat(resolve(top, path)).then(
          () => true,
          (error) => {
            if (missing(error)) return false;
            throw error;
          },
        )
      )
        return { ok: false, reason: '项目正在合并或变基，没有带到设备上。' };
    }
    if ((await git(['rev-parse', '--is-shallow-repository'])) === 'true')
      return { ok: false, reason: '项目是浅克隆，没有带到设备上。' };
    const root = (await git(['rev-list', '--max-parents=0', 'HEAD'])).split(/\r?\n/).at(-1)!;
    const warnings: string[] = [];
    if (
      await lstat(join(top, '.gitmodules')).then(
        () => true,
        () => false,
      )
    )
      warnings.push('项目含子模块；子模块的工作文件不会随项目带过去。');
    if (/filter\s*=\s*lfs/.test(await readFile(join(top, '.gitattributes'), 'utf8').catch(() => '')))
      warnings.push('项目使用 Git LFS；设备可能需要另行下载 LFS 文件。');
    await pruneShuttleRefs(top, 7 * 24 * 60 * 60_000);
    // Keep NUL-delimited paths intact, including leading/trailing whitespace and literal glob characters.
    const list = async (args: string[]) => paths((await hostGit(top, args, { readUserConfig: true, signal })).stdout);
    const untracked = await list(['ls-files', '-o', '--exclude-standard', '-z']);
    const changed = await list(['diff', '--name-only', '--no-renames', '-z', 'HEAD']);
    const added = new Set([
      ...untracked,
      ...(await list(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', 'HEAD'])),
    ]);
    const kept: string[] = [];
    const leftOut: string[] = [];
    let total = 0;
    for (const path of new Set([...untracked, ...changed])) {
      signal?.throwIfAborted();
      const file = join(top, path);
      const info = await lstat(file).catch((error) => {
        if (missing(error)) return undefined;
        throw error;
      });
      let exclude = secretNamePattern.test(path) || (info?.size ?? 0) > maxShuttleBytes;
      if (!exclude && added.has(path) && info?.isFile()) {
        const handle = await open(file, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(info.size, 1024 ** 2));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const sample = buffer.subarray(0, bytesRead);
          if (!sample.includes(0))
            exclude = scanOutbound([{ field: path, value: sample.toString('utf8'), only: ['secret'] }], {}).length > 0;
        } finally {
          await handle.close();
        }
      }
      if (exclude) {
        leftOut.push(path);
        continue;
      }
      total += info?.size ?? 0;
      if (total > maxShuttleBytes) return { ok: false, reason: tooLarge(total) };
      kept.push(path);
    }
    temporary = await mkdtemp(join(tmpdir(), 'pugport-shuttle-index-'));
    const index = join(temporary, 'index');
    await git(['read-tree', 'HEAD'], { index });
    let snapshot = head;
    if (kept.length) {
      await git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        index,
        timeoutMs: 600_000,
        input: kept.join('\0') + '\0',
      });
      const tree = await git(['write-tree'], { index });
      if (tree !== (await git(['rev-parse', 'HEAD^{tree}'])))
        snapshot = await git(['commit-tree', tree, '-p', head, '-m', 'PugPort: uncommitted changes (snapshot)']);
    }
    await git(['update-ref', ref, snapshot]);
    pinned = true;
    await git(['bundle', 'create', bundle, ref], { timeoutMs: 600_000 });
    await git(['bundle', 'verify', bundle], { timeoutMs: 600_000 });
    const bytes = (await stat(bundle)).size;
    if (bytes > maxShuttleBytes) throw new Error(tooLarge(bytes));
    return {
      ok: true,
      top,
      root,
      subpath: relative(top, await realpath(cwd))
        .split(sep)
        .join('/'),
      head,
      snapshot,
      ref,
      bundle,
      bytes,
      leftOut,
      warnings,
    };
  } catch (error) {
    if (pinned) await dropShuttleRef(top, tripId).catch(() => {});
    await rm(bundle, { force: true }).catch(() => {});
    return { ok: false, reason: `项目没有带到设备上：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export function deviceBranchSlug(device: { id: string; name: string }): string {
  if (!/^[\x20-\x7e]+$/.test(device.name)) return device.id.slice(0, 8);
  return (
    device.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || device.id.slice(0, 8)
  );
}

export async function landDeviceBranch(
  top: string,
  bundle: string,
  snapshot: string,
  device: { id: string; name: string },
  signal?: AbortSignal,
): Promise<{ branch: string; head: string; commits: number; files: number }> {
  if (!/^[a-f0-9]{40,64}$/.test(snapshot)) throw new Error('Invalid repository snapshot.');
  const git = (args: string[], options: Parameters<typeof hostGit>[2] = {}) =>
    hostGit(top, args, { readUserConfig: true, signal, ...options });
  await git(['cat-file', '-e', `${snapshot}^{commit}`]);
  await git(['bundle', 'verify', bundle], { timeoutMs: 600_000 });
  const heads = (await git(['bundle', 'list-heads', bundle])).stdout;
  const head = /^([a-f0-9]{40,64}) HEAD\r?$/m.exec(heads)?.[1];
  if (!head) throw new Error('设备返回的 bundle 没有 HEAD。');
  const base = `device/${deviceBranchSlug(device)}/${head.slice(0, 8)}`;
  let branch = base;
  validBranch(branch);
  for (
    let n = 2;
    !(await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })).code;
    n++
  )
    branch = `${base}-${n}`;
  validBranch(branch);
  await git(
    [
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      'fetch',
      '--no-write-fetch-head',
      bundle,
      `HEAD:refs/heads/${branch}`,
    ],
    { timeoutMs: 600_000 },
  );
  const commits = Number((await git(['rev-list', '--count', `${snapshot}..${branch}`])).stdout.trim());
  const files = paths((await git(['diff', '--name-only', '-z', snapshot, branch])).stdout).length;
  return { branch, head, commits, files };
}

export async function dropShuttleRef(top: string, tripId: string): Promise<void> {
  await hostGit(top, ['update-ref', '-d', tripRef(tripId)], { readUserConfig: true });
}

export async function pruneShuttleRefs(top: string, olderThanMs: number): Promise<void> {
  const result = await hostGit(
    top,
    ['for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/pugport/shuttle/'],
    { readUserConfig: true },
  );
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const [ref, date] = line.split(' ');
    if (
      ref &&
      /^refs\/pugport\/shuttle\/[A-Za-z0-9-]{1,100}$/.test(ref) &&
      Number(date) * 1000 < Date.now() - olderThanMs
    )
      await hostGit(top, ['update-ref', '-d', ref], { readUserConfig: true });
  }
}

export function mergeAdvice(branch: string, snapshot8: string, snapshotIsHead: boolean): string {
  return snapshotIsHead
    ? `合并：git merge ${branch}`
    : `套用改动（不动你未提交的修改）：\ngit diff --binary ${snapshot8} ${branch} --output=pugport-device.patch\ngit apply pugport-device.patch`;
}
