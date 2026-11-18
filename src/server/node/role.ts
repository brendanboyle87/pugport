import { appDirs } from '../platform/dirs.ts';
import { currentHost, type Host } from '../platform/host.ts';

/**
 * A PugPort backend is either the desktop app's (the default) or a headless device node (`PUGPORT_ROLE=node`) on
 * another computer of the owner's, which takes tasks from the desktop PugPort over Tailscale.
 */
export type ServerRole = 'desktop' | 'node';

export function serverRole(env: NodeJS.ProcessEnv = process.env): ServerRole {
  return env.PUGPORT_ROLE?.trim().toLowerCase() === 'node' ? 'node' : 'desktop';
}

/** Background work that only makes sense next to a person at the desktop. */
export type DesktopWork = {
  /** Picture folders analyzed in the background, so image searches answer from an index. */
  imageIndex: boolean;
  /** The conversation-history vector index. */
  memoryIndex: boolean;
  /** The test_page tool, which drives a page in the desktop app's own browser. */
  pageTests: boolean;
};

const featureNames: Record<string, keyof DesktopWork> = {
  images: 'imageIndex',
  memory: 'memoryIndex',
  'page-tests': 'pageTests',
};

/** All on for the desktop; a node turns each on only when `PUGPORT_NODE_FEATURES` names it (e.g. "images,memory"). */
export function desktopWork(env: NodeJS.ProcessEnv = process.env): DesktopWork {
  if (serverRole(env) === 'desktop') return { imageIndex: true, memoryIndex: true, pageTests: true };
  const work: DesktopWork = { imageIndex: false, memoryIndex: false, pageTests: false };
  for (const name of (env.PUGPORT_NODE_FEATURES ?? '').split(',')) {
    const key = featureNames[name.trim().toLowerCase()];
    if (key) work[key] = true;
  }
  return work;
}

/**
 * A node's backend listens on 127.0.0.1:4319 (PUGPORT_PORT changes it), so it runs beside the desktop app's 4317 on
 * one computer. Its Tailscale listener is separate (4318).
 */
export const nodeLocalPort = 4319;

/**
 * Where the backend keeps its data when COMBORUNNER_DATA_DIR is not set: the app folder's `.data` for the desktop
 * (as before), the per-user data folder for a node (Linux `~/.local/share/pugport/data`).
 */
export function defaultDataDir(root: string, env: NodeJS.ProcessEnv = process.env, host: Host = currentHost()) {
  return serverRole(env) === 'node' ? host.path.join(appDirs(host).memoryBase, 'data') : host.path.join(root, '.data');
}

/**
 * Why a node must not use `dataDir`: it is a folder the desktop app on this computer uses (src/electron/data-directory.ts:
 * the packaged app's `<appData>/ComboRunner/data` or older `Agent Studio/data`, a source checkout's `.data`).
 */
export function nodeDataProblem(root: string, dataDir: string, host: Host = currentHost()): string | undefined {
  const appData = appDirs(host).userConfig;
  const key = (dir: string) => {
    const full = host.path.resolve(dir);
    // APFS and NTFS ignore case by default.
    return host.platform === 'linux' ? full : full.toLowerCase();
  };
  const desktop = [
    host.path.join(appData, 'ComboRunner', 'data'),
    host.path.join(appData, 'Agent Studio', 'data'),
    host.path.join(root, '.data'),
  ].find((dir) => key(dir) === key(dataDir));
  return desktop && `${desktop} 是桌面版 PugPort 的数据目录，设备节点要用自己的目录（COMBORUNNER_DATA_DIR）。`;
}
