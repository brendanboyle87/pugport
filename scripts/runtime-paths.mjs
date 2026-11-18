import { homedir } from 'node:os';
import path from 'node:path';

const paths = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * The user's own folder for downloaded components (src/server/platform/dirs.ts reads it from here): Windows
 * %LOCALAPPDATA%\PugPort\runtime, macOS ~/Library/Application Support/PugPort/runtime, Linux
 * $XDG_DATA_HOME/pugport/runtime.
 */
export function userRuntimeRoot(env = process.env, platform = process.platform, home = undefined) {
  const { isAbsolute, join } = paths(platform);
  const user = home ?? (platform === 'win32' ? homedir() : env.HOME || homedir());
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(user, '.local', 'share'), 'PugPort', 'runtime');
  if (platform === 'darwin') return join(user, 'Library', 'Application Support', 'PugPort', 'runtime');
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(user, '.local', 'share');
  return join(data, 'pugport', 'runtime');
}

/** Downloads belong to the user, not to a read-only/replaceable installed application. */
export function runtimeRoot(appRoot, env = process.env, platform = process.platform) {
  const { basename, dirname, isAbsolute, join, resolve } = paths(platform);
  const override = env.PUGPORT_RUNTIME_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error('PUGPORT_RUNTIME_DIR must be an absolute directory.');
    return resolve(override);
  }
  const packaged =
    basename(appRoot).toLowerCase() === 'app' && basename(dirname(appRoot)).toLowerCase() === 'resources';
  if (!packaged) return join(appRoot, '.runtime');
  return userRuntimeRoot(env, platform);
}

/** Retain old portable/offline installations without moving or deleting their files. */
export function runtimeDirectories(appRoot, component, env = process.env, platform = process.platform) {
  const { join } = paths(platform);
  return [
    ...new Set([
      join(runtimeRoot(appRoot, env, platform), component),
      join(appRoot, '.runtime', component),
      join(appRoot, '..', component),
    ]),
  ];
}
