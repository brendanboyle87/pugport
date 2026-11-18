import { currentHost, type Host } from './host.ts';

/**
 * A directory the app was given, with symbolic links resolved in the folders above it (macOS and Linux).
 *
 * Ownership checks refuse links so that nothing the app writes or deletes can be redirected: an lstat walk over
 * every folder of a path, or `realpath(path) === path`. Those checks also covered the folders above the directory
 * the app was given, which belong to the system or the user. On macOS /var, /tmp and /etc are links into /private
 * and os.tmpdir() is below /var, so every such check refused any folder in the temporary directory; a home or a
 * checkout reached through a link was refused the same way. Linux systems can link /home or /var/run.
 *
 * Only the parent is resolved. The directory's own name and everything the caller builds below it stay as given,
 * so a link there (the directory itself replaced by a link, or a link inside it) is still seen and refused by the
 * caller's own check. Missing folders above it are kept as written: they cannot be links yet.
 *
 * Windows returns `directory` unchanged, so its checks keep refusing junctions anywhere on the path as before.
 * Pass the directory the app was given (a data or cache folder, a project folder, a configured root) or a fixed
 * folder directly inside it. Never pass a path deeper inside a workspace or any folder a task can write: resolving
 * its parents would follow a link planted there.
 */
export function trustedDirectory(directory: string, host: Host = currentHost()): string {
  if (host.platform === 'win32') return directory;
  const { path } = host;
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(resolvedExisting(parent, host), path.basename(absolute));
}

/** `folder` with links resolved in its longest existing part; the missing rest is appended unchanged. */
function resolvedExisting(folder: string, host: Host): string {
  const { path } = host;
  const missing: string[] = [];
  for (let current = folder; ;) {
    try {
      return path.join(host.fs.realpathSync(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const up = path.dirname(current);
      if (up === current) return folder;
      missing.unshift(path.basename(current));
      current = up;
    }
  }
}
