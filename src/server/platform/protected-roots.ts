import { userFolders } from './dirs.ts';
import { currentHost, type Host } from './host.ts';

export type ProtectedRoots = {
  home: string;
  /** System, program and application-data folders: nothing inside is tidied and none of them is ever moved. */
  system: string[];
  /** Folders inside `system` that hold the user's own things (unpacked archives, downloads in progress). */
  allowedInside: string[];
  /** The user's main folders: what they hold can be tidied, the folder itself never moves. */
  main: string[];
  /** System folder names on any drive (Recycle Bin and Trash folders, volume indexes). */
  systemNames: RegExp;
};

/*
 * The file keeper's safety boundary. Windows is unchanged from before this module existed. macOS and Linux add
 * their system trees, the app-data and key folders in the home folder (the counterpart of ~/AppData), and
 * Trash folders. Unknown platforms get the Linux list.
 */
export function protectedRoots(host: Host = currentHost()): ProtectedRoots {
  const { path, env, home } = host;
  const inHome = (...names: string[]) => names.map((name) => path.join(home, name));
  if (host.platform === 'win32')
    return {
      home,
      system: [
        env.SystemRoot || 'C:\\Windows',
        env.ProgramFiles || 'C:\\Program Files',
        env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        env.ProgramData || 'C:\\ProgramData',
        path.join(home, 'AppData'),
      ],
      allowedInside: [path.join(home, 'AppData', 'Local', 'Temp')],
      main: inHome('Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'),
      systemNames: /[\\/](?:\$Recycle\.Bin|System Volume Information)(?:[\\/]|$)/i,
    };
  const keys = inHome('.ssh', '.gnupg', '.config', '.local');
  // The temporary folder in both spellings: macOS TMPDIR is /var/folders/…, really /private/var/folders/….
  const temporary = [host.tmpdir];
  try {
    temporary.push(host.fs.realpathSync(host.tmpdir));
  } catch {
    // Without its real path, only the given spelling is allowed.
  }
  const allowedInside = [...new Set(temporary)];
  const trash =
    /(?:^|\/)(?:\.Trash(?:es|-\d+)?|\.Spotlight-V100|\.fseventsd|\.DocumentRevisions-V100|lost\+found)(?:\/|$)/i;
  if (host.platform === 'darwin')
    return {
      home,
      // /etc, /var and /tmp are links into /private: the check of each path's real location covers them.
      system: [
        '/System',
        '/Library',
        '/Applications',
        '/usr',
        '/bin',
        '/sbin',
        '/opt',
        '/private',
        '/cores',
        '/dev',
        ...inHome('Library'),
        ...keys,
      ],
      allowedInside,
      main: [...Object.values(userFolders(host)), ...inHome('Applications')],
      systemNames: trash,
    };
  const folders = userFolders(host);
  const english = inHome('Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'Public', 'Templates');
  return {
    home,
    system: [
      '/bin',
      '/boot',
      '/dev',
      '/etc',
      '/lib',
      '/lib32',
      '/lib64',
      '/libx32',
      '/opt',
      '/proc',
      '/root',
      '/run',
      '/sbin',
      '/snap',
      '/sys',
      '/usr',
      '/var',
      ...inHome('.cache'),
      ...keys,
    ],
    allowedInside,
    main: [...new Set([...english, ...Object.values(folders)])],
    systemNames: trash,
  };
}

/** Comparison key: Windows and macOS (APFS by default) do not distinguish letter case. */
export function protectionKey(path: string, host: Host = currentHost()): string {
  return host.platform === 'win32' || host.platform === 'darwin' ? path.toLowerCase() : path;
}

/** Whether `path` is strictly inside `folder`, by spelling (links are checked separately). */
export function protectedInside(path: string, folder: string, host: Host = currentHost()): boolean {
  const rest = host.path.relative(protectionKey(folder, host), protectionKey(path, host));
  const parent = host.platform === 'win32' ? /^\.\.[\\/]/ : /^\.\.\//;
  return !!rest && rest !== '..' && !parent.test(rest) && !host.path.isAbsolute(rest);
}
