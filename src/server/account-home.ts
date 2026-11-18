import { lstat, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { moveToRecycleBin } from './recycle-bin.ts';
import { trustedDirectory } from './platform/trusted-path.ts';
import { withAccountConfigLock } from './account-shared-config.ts';

/**
 * Detach links only inside a real account folder directly below PugPort's accounts directory.
 * Refuse links at the root, the accounts directory itself, and anything outside it.
 */
async function prepareAccountHomeRemoval(accountsDirectory: string, home: string): Promise<boolean> {
  try {
    const rootInfo = await lstat(accountsDirectory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return false;
    const root = await realpath(accountsDirectory);
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    // Links above the accounts folder belong to the system (macOS /var), as when the account was created.
    if (
      fold(root) !== fold(resolve(trustedDirectory(accountsDirectory))) ||
      fold(await realpath(home)) !== fold(resolve(home))
    )
      return false;
    const inside = relative(fold(root), fold(await realpath(home)));
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.includes(sep)) return false;
    // lstat before descending: detach every link, including user-created and broken links, without visiting its target.
    const detach = async (directory: string): Promise<void> => {
      const current = await lstat(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        fold(await realpath(directory)) !== fold(resolve(directory))
      )
        throw new Error('账号目录在移除期间发生变化');
      for (const name of await readdir(directory)) {
        const child = join(directory, name);
        const entry = await lstat(child);
        if (entry.isSymbolicLink()) await unlink(child);
        else if (entry.isDirectory()) await detach(child);
      }
    };
    await detach(home);
    return true;
  } catch {
    return false;
  }
}

export async function deleteAccountHome(accountsDirectory: string, home: string): Promise<boolean> {
  return withAccountConfigLock(home, async () => {
    if (!(await prepareAccountHomeRemoval(accountsDirectory, home))) return false;
    return rm(home, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
  });
}

export async function recycleAccountHome(
  accountsDirectory: string,
  home: string,
  recycle: typeof moveToRecycleBin = moveToRecycleBin,
): Promise<boolean> {
  return withAccountConfigLock(home, async () => {
    if (!(await prepareAccountHomeRemoval(accountsDirectory, home))) return false;
    return recycle(accountsDirectory, [home]).then(
      (result) => result.moved.includes(home),
      () => false,
    );
  });
}
