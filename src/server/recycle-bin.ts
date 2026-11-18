import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { capabilities } from './platform/host.ts';
import { moveToTrash, recycleScript, trashName } from './platform/trash.ts';

/** Kept here for the tests that pin the Windows script. */
export { recycleScript };

export type RecycleResult = { moved: string[]; failed: { path: string; reason: string }[] };

export const maxRecyclePaths = 200;

/**
 * Resolves requested paths against the project and keeps only existing entries strictly inside it.
 * A path inside another requested folder is dropped, since recycling the folder already covers it.
 */
export async function recyclablePaths(
  projectPath: string,
  requested: unknown,
): Promise<RecycleResult & { paths: string[] }> {
  if (!Array.isArray(requested) || !requested.length || requested.some((value) => typeof value !== 'string'))
    throw new Error('请用 paths 传入要移到回收站的文件或文件夹路径列表。');
  if (requested.length > maxRecyclePaths) throw new Error(`一次最多移动 ${maxRecyclePaths} 个路径。`);
  if ((await lstat(projectPath)).isSymbolicLink()) throw new Error('项目目录是链接或目录联接，不能代为回收');
  const root = await realpath(projectPath);
  const project = resolve(projectPath);
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const failed: RecycleResult['failed'] = [];
  const accepted: string[] = [];
  for (const value of requested as string[]) {
    const absolute = resolve(project, value);
    let real: string;
    try {
      const lexical = [project, root].map((base) => relative(fold(base), fold(absolute)));
      if (
        lexical.includes('') ||
        !lexical.some((path) => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      ) {
        failed.push({ path: value, reason: lexical.includes('') ? '不能回收项目目录本身' : '不在当前项目目录内' });
        continue;
      }
      let linked = false;
      const entries: string[] = [];
      for (
        let entry = absolute;
        fold(entry) !== fold(root) && fold(entry) !== fold(project) && dirname(entry) !== entry;
        entry = dirname(entry)
      ) {
        entries.unshift(entry);
      }
      for (const entry of entries) {
        if ((await lstat(entry)).isSymbolicLink()) {
          linked = true;
          break;
        }
      }
      // Resolving a leaf link would change the user's selected item into its target.
      if (linked) {
        failed.push({
          path: value,
          reason: '这是链接或目录联接，不能代为回收它指向的目标；请明确选择实际文件或文件夹。',
        });
        continue;
      }
      real = await realpath(absolute);
      const blockedTree = async (entry: string): Promise<boolean> => {
        if (/[\\/]\.git(?:[\\/]|$)/i.test(entry) || /(?:^|[\\/])\.data(?:[\\/]|$)/i.test(relative(root, entry)))
          return true;
        const info = await lstat(entry);
        if (info.isSymbolicLink()) return true;
        if (info.isDirectory())
          for (const name of await readdir(entry)) if (await blockedTree(join(entry, name))) return true;
        return false;
      };
      if (await blockedTree(real)) {
        failed.push({ path: value, reason: '包含 Git、应用数据目录或链接或目录联接，不能回收' });
        continue;
      }
    } catch {
      failed.push({ path: value, reason: '不存在' });
      continue;
    }
    const inside = relative(fold(root), fold(real));
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      failed.push({ path: value, reason: inside ? '不在当前项目目录内' : '不能回收项目目录本身' });
      continue;
    }
    if (!accepted.some((other) => fold(other) === fold(real))) accepted.push(real);
  }
  const paths = accepted.filter(
    (path) => !accepted.some((other) => other !== path && fold(path).startsWith(fold(other) + sep)),
  );
  return { paths, moved: [], failed };
}

/**
 * Sends files to the Recycle Bin / Trash, never deleting permanently (see platform/trash.ts). Windows: a drive
 * without a Recycle Bin, a disabled one, or an item larger than its capacity is refused up front, and Windows'
 * own "delete permanently?" warning stays on as a last guard (an unanswered prompt times out with nothing
 * deleted). macOS and Linux refuse what their Trash cannot take.
 */
export async function moveToRecycleBin(projectPath: string, requested: unknown, signal?: AbortSignal) {
  if (!capabilities().trash) throw new Error('这台电脑的系统不支持移到回收站。');
  const checked = await recyclablePaths(projectPath, requested);
  if (!checked.paths.length) return { moved: [], failed: checked.failed };
  const list = await moveToTrash(checked.paths, signal);
  const moved: string[] = [];
  const failed = [...checked.failed];
  for (const result of list) {
    // Trust the file system over the script: an item still present was not moved.
    const gone = await stat(result.path).then(
      () => false,
      () => true,
    );
    if (result.ok && gone) moved.push(result.path);
    else failed.push({ path: result.path, reason: result.reason || `未能移到${trashName()}` });
  }
  return { moved, failed };
}
