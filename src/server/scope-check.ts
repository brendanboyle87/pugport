import { trackBusy } from './backend-activity.ts';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runGit } from './git.ts';

/*
 * What changed in a project while a subtask ran: the uncommitted files git reports, each with its modification
 * time and content digest, taken when the subtask starts and again when it ends. A file is counted as changed
 * when it newly appears, its time moved, or its bytes changed within the same filesystem clock tick. Without git
 * (or outside a repository) nothing can be checked.
 */

export type Snapshot = Map<string, number>;

const snapshotDigests = new WeakMap<Snapshot, Map<string, string>>();

export async function dirtyFiles(projectPath: string, signal?: AbortSignal): Promise<Snapshot | undefined> {
  const end = trackBusy('git-scope-snapshot');
  try {
    return await dirtyFilesImpl(projectPath, signal);
  } finally {
    end();
  }
}

async function dirtyFilesImpl(projectPath: string, signal?: AbortSignal): Promise<Snapshot | undefined> {
  // Stopping git on shutdown matters on Windows: a running git holds the project folder open.
  const result = await runGit(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    timeoutMs: 20_000,
    maxBuffer: 32 * 1024 * 1024,
    signal,
  });
  if (result === undefined) return undefined;
  const entries = result.split('\0');
  const files: string[] = [];
  for (let index = 0; index < entries.length && files.length < 20_000; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // A rename lists the old name next; the new one is what changed.
    if (entry[0] === 'R' || entry[0] === 'C') index++;
  }
  const snapshot: Snapshot = new Map();
  const digests = new Map<string, string>();
  snapshotDigests.set(snapshot, digests);
  await Promise.all(
    files.map(async (file) => {
      const fullPath = join(projectPath, file);
      const key = file.replace(/\\/g, '/');
      const info = await stat(fullPath).catch(() => undefined);
      snapshot.set(key, info ? Math.round(info.mtimeMs) : -1);
      if (!info) {
        digests.set(key, 'missing');
        return;
      }
      if (info.isFile() && info.size <= 8 * 1024 * 1024) {
        const bytes = await readFile(fullPath).catch(() => undefined);
        if (bytes) {
          digests.set(key, `${info.size}:${createHash('sha1').update(bytes).digest('hex')}`);
          return;
        }
      }
      digests.set(key, `${info.size}:${info.mtimeMs}`);
    }),
  );
  return snapshot;
}

/** Files that changed between two snapshots (new, edited again, or deleted). */
export function changedBetween(before: Snapshot, after: Snapshot): string[] {
  const end = trackBusy('git-scope-diff');
  try {
    const beforeDigests = snapshotDigests.get(before);
    const afterDigests = snapshotDigests.get(after);
    return [...after]
      .filter(
        ([file, time]) =>
          before.get(file) !== time ||
          (beforeDigests !== undefined &&
            afterDigests !== undefined &&
            beforeDigests.get(file) !== afterDigests.get(file)),
      )
      .map(([file]) => file);
  } finally {
    end();
  }
}

export async function headCommit(projectPath: string, signal?: AbortSignal): Promise<string | undefined> {
  const end = trackBusy('git-scope-snapshot');
  try {
    const result = await runGit(projectPath, ['rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: 20_000, signal });
    const sha = result?.trim();
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
  } finally {
    end();
  }
}

export async function committedBetween(
  projectPath: string,
  before: string | undefined,
  after: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const end = trackBusy('git-scope-diff');
  try {
    const options = { timeoutMs: 20_000, maxBuffer: 32 * 1024 * 1024, signal };
    const args = before
      ? ['diff', '--name-only', '-z', before, after]
      : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', after];
    // Git starts slowly here, so the checks run together. A descendant includes merges made during the run;
    // without a start commit only a first commit is provable.
    const [ancestor, parent, result] = await Promise.all([
      before ? runGit(projectPath, ['merge-base', '--is-ancestor', before, after], options) : '',
      before ? undefined : runGit(projectPath, ['rev-parse', '--verify', '-q', `${after}^`], options),
      runGit(projectPath, args, options),
    ]);
    if (ancestor === undefined || parent?.trim()) return [];
    return (result?.split('\0').filter(Boolean).slice(0, 20_000) ?? []).map((file) => file.replace(/\\/g, '/'));
  } finally {
    end();
  }
}

export async function freshlyChanged(projectPath: string, files: string[], before: Snapshot): Promise<string[]> {
  const end = trackBusy('git-scope-diff');
  try {
    const keep = await Promise.all(
      files.map(async (file) => {
        if (!before.has(file)) return true;
        return stat(join(projectPath, file)).then(
          (info) => Math.round(info.mtimeMs) !== before.get(file),
          // Gone now counts only if it existed at the start (-1 there means it was already missing).
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT' && before.get(file) !== -1,
        );
      }),
    );
    return files.filter((_, index) => keep[index]);
  } finally {
    end();
  }
}

/** A host-verified HEAD advance is evidence even when commits have no net file diff. */
export async function headAdvanced(
  projectPath: string,
  before: string | undefined,
  after: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!after || before === after) return false;
  const options = { timeoutMs: 20_000, signal };
  if (before) return (await runGit(projectPath, ['merge-base', '--is-ancestor', before, after], options)) !== undefined;
  const [head, parent] = await Promise.all([
    headCommit(projectPath, signal),
    runGit(projectPath, ['rev-parse', '--verify', '-q', `${after}^`], options),
  ]);
  return head === after && !parent?.trim();
}

/** Avoid spawning Git for ordinary folders; linked worktrees use a .git file. */
export function hasGitMetadata(projectPath: string): boolean {
  let current = resolve(projectPath);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
