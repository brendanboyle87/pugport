import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** One-time source-folder rename compatibility. Never guess where unrelated projects moved. */
export function relocatedProjectPath(path: string, root: string): string {
  if (!['comborunner', 'pugport'].includes(basename(root).toLowerCase()) || !isAbsolute(path) || existsSync(path))
    return path;
  const oldRoot = join(dirname(root), 'agent-studio');
  if (existsSync(oldRoot)) return path;
  const tail = relative(oldRoot, path);
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) return path;
  const candidate = resolve(root, tail);
  try {
    return statSync(candidate).isDirectory() ? candidate : path;
  } catch {
    return path;
  }
}
