import { existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { hostGit } from '../managed-worktrees.ts';
import { currentHost } from '../platform/host.ts';
import { isolatedUserPath } from '../platform/under-test.ts';
import type { WorkspaceStore } from '../workspace-store.ts';
import { secretNamePattern } from '../devices/repo-shuttle.ts';
import { projectFolderCheck } from './device-node.ts';
import { settledStatuses } from './peer-protocol.ts';
import type { PeerTaskRunner } from './peer-tasks.ts';

export type RepoStore = Pick<WorkspaceStore, 'get' | 'save'>;
export type PeerRepoRecord = {
  peerId: string;
  peerName: string;
  key: string;
  trip: string;
  snapshot: string;
  path: string;
  lastTaskId?: string;
  lastTaskAt?: number;
};
export function peerRepoBusy(repo: PeerRepoRecord, runner: PeerTaskRunner): boolean {
  if (!repo.lastTaskId || (repo.lastTaskAt !== undefined && Date.now() - repo.lastTaskAt >= 24 * 60 * 60 * 1000))
    return false;
  const status = runner.status(repo.lastTaskId);
  return !!status && !settledStatuses.has(status.status);
}
export const repoImportSchema = z
  .object({
    bundlePath: z.string().min(1).max(4000),
    snapshot: z.string().regex(/^[a-f0-9]{40,64}$/),
    trip: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  })
  .strict();
export type RepoImport = z.infer<typeof repoImportSchema> & { key: string };
export type RepoImporter = (
  peer: { id: string; name: string },
  input: RepoImport,
) => Promise<{ path: string; head: string }>;
export class PeerRepoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const locks = new WeakMap<RepoStore, Map<string, Promise<unknown>>>();
/** Import, task dispatch and result export share one checkout lease. */
export async function withPeerRepo<T>(store: RepoStore, path: string, operation: () => Promise<T>): Promise<T> {
  let queues = locks.get(store);
  if (!queues) locks.set(store, (queues = new Map()));
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const previous = queues.get(key);
  const pending = (previous ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (queues.get(key) === pending) queues.delete(key);
  }
}
export function findPeerRepo(store: RepoStore, path: string | undefined): PeerRepoRecord | undefined {
  if (!path) return undefined;
  for (let folder = resolve(path); ; folder = dirname(folder)) {
    const record = store.get<PeerRepoRecord>('peer-repo', folder);
    if (record) return record;
    if (dirname(folder) === folder) return undefined;
  }
}
const git = (dir: string, args: string[], allowFailure = false) =>
  hostGit(dir, args, { readUserConfig: true, timeoutMs: 600_000, allowFailure });
const text = async (dir: string, args: string[]) => (await git(dir, args)).stdout.trim();

export function createRepoImporter(store: RepoStore, runner: PeerTaskRunner, home = currentHost().home): RepoImporter {
  return async (peer, input) => {
    const { key } = input;
    if (!/^[a-f0-9]{16}$/.test(key)) throw new PeerRepoError(400, '项目标识不对。');
    repoImportSchema.parse({ bundlePath: input.bundlePath, snapshot: input.snapshot, trip: input.trip });
    try {
      const dir = join(isolatedUserPath(home), 'PugPort-Workspace', 'repos', key);
      await mkdir(dir, { recursive: true });
      const real = projectFolderCheck()(dir);
      if (!real) throw new PeerRepoError(400, '这台设备上没有这个文件夹，或它不能用作项目文件夹。');
      return await withPeerRepo(store, real, async () => {
        const previous = store.get<PeerRepoRecord>('peer-repo', real);
        if (previous && previous.peerId !== peer.id) throw new PeerRepoError(404, '没有这个项目。');
        if (previous && peerRepoBusy(previous, runner))
          throw new PeerRepoError(409, '这个项目在设备上的上一条任务还没结束');
        if (!existsSync(join(real, '.git'))) await git(real, ['init', '-q']);
        await git(real, ['bundle', 'verify', input.bundlePath]);
        const heads = await text(real, ['bundle', 'list-heads', input.bundlePath]);
        if (!heads.split(/\r?\n/).some((line) => line === `${input.snapshot} refs/pugport/shuttle/${input.trip}`))
          throw new PeerRepoError(400, '项目快照与传来的分支不符。');
        if (await text(real, ['status', '--porcelain'])) {
          await git(real, ['add', '-A']);
          await git(real, ['commit', '-m', `PugPort: leftover from ${previous?.trip ?? 'unknown'}`]);
          await git(real, ['update-ref', `refs/pugport/leftover/${previous?.trip ?? 'unknown'}`, 'HEAD']);
        }
        await git(real, [
          'fetch',
          input.bundlePath,
          `refs/pugport/shuttle/${input.trip}:refs/pugport/shuttle/${input.trip}`,
        ]);
        await git(real, ['checkout', '-B', `pugport/${input.trip}`, `refs/pugport/shuttle/${input.trip}`]);
        await git(real, ['clean', '-fd']);
        const head = await text(real, ['rev-parse', 'HEAD']);
        store.save('peer-repo', real, peer.id, {
          peerId: peer.id,
          peerName: peer.name,
          key,
          trip: input.trip,
          snapshot: input.snapshot,
          path: real,
        } satisfies PeerRepoRecord);
        return { path: real, head };
      });
    } catch (error) {
      if (/spawn (?:.*[/\\])?git(?:\.exe)? ENOENT/.test(error instanceof Error ? error.message : String(error)))
        throw new PeerRepoError(400, 'no-git');
      throw error;
    } finally {
      await unlink(input.bundlePath).catch(() => {});
    }
  };
}

export type TaskRepo = { path: string; snapshot: string; trip: string; backFolder: string };
export async function exportPeerRepo(store: RepoStore, repo: TaskRepo, peerId: string, taskId: string) {
  return withPeerRepo(store, repo.path, async () => {
    const notes: string[] = [];
    const current = store.get<PeerRepoRecord>('peer-repo', repo.path);
    if (current?.peerId !== peerId || current.trip !== repo.trip || current.lastTaskId !== taskId)
      throw new Error('设备项目已进入下一条任务，未导出其他任务的改动。');
    if (await text(repo.path, ['status', '--porcelain'])) {
      await git(repo.path, ['add', '-A']);
      const dirty = (await git(repo.path, ['diff', '--cached', '--name-only', '-z', 'HEAD'])).stdout
        .split('\0')
        .filter(Boolean);
      const hits = dirty.filter((path) => secretNamePattern.test(path));
      if (hits.length) {
        await git(repo.path, ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...hits]);
        notes.push(`未提交疑似密钥文件：${hits.join('、')}`);
      }
      if ((await git(repo.path, ['diff', '--cached', '--quiet'], true)).code !== 0)
        await git(repo.path, ['commit', '-m', `PugPort device task ${taskId}`]);
    }
    const head = await text(repo.path, ['rev-parse', 'HEAD']);
    if (head === repo.snapshot) return { notes };
    if ((await git(repo.path, ['merge-base', '--is-ancestor', repo.snapshot, 'HEAD'], true)).code !== 0)
      notes.push('设备分支不再基于原来的项目快照，请检查后再合并。');
    const hits = (await git(repo.path, ['diff', '--name-only', '-z', repo.snapshot, 'HEAD'])).stdout
      .split('\0')
      .filter((path) => secretNamePattern.test(path));
    if (hits.length) notes.push(`分支里包含疑似密钥文件：${hits.join('、')}`);
    await mkdir(repo.backFolder, { recursive: true });
    const bundle = join(repo.backFolder, `pugport-back-${taskId}.bundle`);
    try {
      await git(repo.path, ['bundle', 'create', bundle, `^${repo.snapshot}`, 'HEAD']);
    } catch (error) {
      await unlink(bundle).catch(() => {});
      throw new Error([...notes, error instanceof Error ? error.message : String(error)].join('\n'));
    }
    return { bundle, notes };
  });
}
