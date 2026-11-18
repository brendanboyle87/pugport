import { tmpdir } from 'node:os';
import { underTest, testDirectory, insideDirectory, canonicalTestPath } from './under-test.ts';
import { userRuntimeRoot } from '../../../scripts/runtime-paths.mjs';
import { currentHost, type Host } from './host.ts';

/** Per-user folders outside the data folder (which may sync to the cloud). */
export type AppDirs = {
  /** API keys, readable only by this user. */
  secrets: string;
  /** Parent of `memoryBase`: an OS folder that is trusted to exist (or be created) as it is. */
  memoryAnchor: string;
  /** The application folder holding full conversation copies (`<memoryBase>/memory/<identity>`). */
  memoryBase: string;
  vectors: string;
  imageIndex: string;
  everything: string;
  extensions: string;
  fileMoves: string;
  /** Downloaded components (models, tools) of an installed app. */
  runtime: string;
  /** Throwaway copies; undefined when Windows has no LOCALAPPDATA (callers then use the data folder). */
  cache: string | undefined;
  /** Other apps' per-user settings: %APPDATA%, ~/Library/Application Support, $XDG_CONFIG_HOME. */
  userConfig: string;
  /** Older folders that are read, never written, when the current one has nothing yet. */
  legacy: { extensions: string[]; fileMoves: string[] };
};

function insideTemporary(file: string, host: Host): boolean {
  const canonical = (value: string) => {
    try {
      return host.fs.realpathSync.native(value);
    } catch {
      return value;
    }
  };
  if (insideDirectory(canonicalTestPath(file), canonicalTestPath(tmpdir()))) return true;
  const rel = host.path.relative(canonical(host.tmpdir), canonical(file));
  return !host.path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + host.path.sep);
}

/** Windows keeps each caller's historical fallback exactly; macOS and Linux follow their own conventions. */
export function appDirs(host: Host = currentHost()): AppDirs {
  const dirs = defaultAppDirs(host);
  if (underTest()) {
    if (!insideTemporary(dirs.memoryAnchor, host) || !insideTemporary(dirs.memoryBase, host)) {
      dirs.memoryAnchor = testDirectory();
      dirs.memoryBase = host.path.join(dirs.memoryAnchor, 'PugPort');
    }
    for (const key of Object.keys(dirs) as (keyof AppDirs)[]) {
      const value = dirs[key];
      if (typeof value === 'string' && !insideTemporary(value, host))
        Object.assign(dirs, { [key]: host.path.join(testDirectory(), key) });
    }
    dirs.legacy = { extensions: [], fileMoves: [] };
  }
  return dirs;
}

function defaultAppDirs(host: Host): AppDirs {
  const { path, env, home } = host;
  if (host.platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const share = local || path.join(home, '.local', 'share');
    const memoryAnchor = local || path.join(home, 'AppData', 'Local');
    return {
      secrets: path.join(local || home, 'ComboRunner', 'secrets'),
      memoryAnchor,
      memoryBase: path.join(memoryAnchor, 'ComboRunner'),
      vectors: path.join(local || home, 'ComboRunner', 'memory-vectors'),
      imageIndex: path.join(local || home, 'ComboRunner', 'image-index'),
      everything: path.join(local || home, 'ComboRunner', 'everything'),
      extensions: path.join(share, 'ComboRunner', 'extensions'),
      fileMoves: path.join(share, 'ComboRunner', 'file-moves'),
      runtime: userRuntimeRoot(env, 'win32', home),
      cache: local ? path.join(local, 'PugPort', 'Cache') : undefined,
      userConfig: env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      legacy: { extensions: [], fileMoves: [] },
    };
  }
  const folders = (anchor: string, name: string, cache: string, userConfig: string, legacy: AppDirs['legacy']) => {
    const root = path.join(anchor, name);
    return {
      secrets: path.join(root, 'secrets'),
      memoryAnchor: anchor,
      memoryBase: root,
      vectors: path.join(root, 'memory-vectors'),
      imageIndex: path.join(root, 'image-index'),
      everything: path.join(root, 'everything'),
      extensions: path.join(root, 'extensions'),
      fileMoves: path.join(root, 'file-moves'),
      runtime: userRuntimeRoot(env, host.platform, home),
      cache,
      userConfig,
      legacy,
    };
  };
  if (host.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return folders(support, 'PugPort', path.join(home, 'Library', 'Caches', 'PugPort'), support, {
      extensions: [],
      fileMoves: [],
    });
  }
  // XDG Base Directory: a relative value is invalid and ignored.
  const xdg = (name: string, fallback: string) => {
    const value = env[name];
    return value && path.isAbsolute(value) ? value : fallback;
  };
  // Before these folders existed, Linux used ~/.local/share/ComboRunner (no LOCALAPPDATA there).
  const old = path.join(home, '.local', 'share', 'ComboRunner');
  return folders(
    xdg('XDG_DATA_HOME', path.join(home, '.local', 'share')),
    'pugport',
    path.join(xdg('XDG_CACHE_HOME', path.join(home, '.cache')), 'pugport'),
    xdg('XDG_CONFIG_HOME', path.join(home, '.config')),
    { extensions: [path.join(old, 'extensions')], fileMoves: [path.join(old, 'file-moves')] },
  );
}

export type UserFolder =
  'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos' | 'music' | 'public' | 'templates';
const xdgNames: Record<string, UserFolder> = {
  DESKTOP: 'desktop',
  DOCUMENTS: 'documents',
  DOWNLOAD: 'downloads',
  PICTURES: 'pictures',
  VIDEOS: 'videos',
  MUSIC: 'music',
  PUBLICSHARE: 'public',
  TEMPLATES: 'templates',
};

/** `~/.config/user-dirs.dirs` (xdg-user-dirs): localized names such as XDG_PICTURES_DIR="$HOME/图片". */
export function parseUserDirs(text: string, host: Host = currentHost()): Partial<Record<UserFolder, string>> {
  const found: Partial<Record<UserFolder, string>> = {};
  for (const match of text.matchAll(/^\s*XDG_([A-Z]+)_DIR\s*=\s*"([^"\n]*)"\s*$/gm)) {
    const name = xdgNames[match[1]!];
    const value = match[2]!;
    const path = value.startsWith('$HOME/')
      ? host.path.join(host.home, value.slice('$HOME/'.length))
      : host.path.isAbsolute(value)
        ? value
        : undefined;
    // "$HOME/" alone means the folder is turned off.
    if (name && path && host.path.resolve(path) !== host.path.resolve(host.home)) found[name] = path;
  }
  return found;
}

/**
 * The user's library folders. Windows and macOS use their fixed English names (Windows: Videos; macOS: Movies);
 * Linux reads xdg-user-dirs, whose names may be localized, and falls back to the English defaults.
 */
export function userFolders(host: Host = currentHost()): Record<UserFolder, string> {
  const { path, home } = host;
  const english: Record<UserFolder, string> = {
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    pictures: path.join(home, 'Pictures'),
    videos: path.join(home, host.platform === 'darwin' ? 'Movies' : 'Videos'),
    music: path.join(home, 'Music'),
    public: path.join(home, 'Public'),
    templates: path.join(home, 'Templates'),
  };
  if (host.platform === 'win32' || host.platform === 'darwin') return english;
  try {
    const file = path.join(appDirs(host).userConfig, 'user-dirs.dirs');
    return { ...english, ...parseUserDirs(host.fs.readFileSync(file, 'utf8'), host) };
  } catch {
    return english;
  }
}
