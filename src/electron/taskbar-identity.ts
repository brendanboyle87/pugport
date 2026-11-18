import { app, shell, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// A new ID drops the icon Windows cached for the old one (Electron's, from before the shortcut existed).
export const APP_USER_MODEL_ID = 'ComboRunner.App';

const VERSIONED = /^pugport-[0-9a-f]{12}\.ico$/;
let versioned: { source: string; path: string } | undefined;

/**
 * The app icon under a name that carries its content hash. Windows caches shortcut and taskbar icons by file
 * path, so a new picture saved over the same pugport.ico keeps showing the old one; a new name never does.
 * Older copies are removed. Falls back to pugport.ico itself when the copy cannot be made.
 */
export function versionedAppIcon(iconsDir: string): string | undefined {
  const source = join(iconsDir, 'pugport.ico');
  if (!existsSync(source)) return undefined;
  try {
    const bytes = readFileSync(source);
    const directory = join(app.getPath('userData'), 'brand');
    const target = join(directory, `pugport-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.ico`);
    if (versioned?.source === source && versioned.path === target && existsSync(target)) return target;
    mkdirSync(directory, { recursive: true });
    if (!existsSync(target)) writeFileSync(target, bytes);
    for (const name of readdirSync(directory))
      if (VERSIONED.test(name) && name !== basename(target))
        try {
          rmSync(join(directory, name));
        } catch {
          /* Still open somewhere; a later start removes it. */
        }
    versioned = { source, path: target };
    return target;
  } catch {
    return source;
  }
}

/** Whether a shortcut's icon is one of ours: pugport.ico in the icons folder, or any versioned copy. */
function ourIcon(icon: string | undefined, iconsDir: string) {
  if (!icon) return false;
  const lower = icon.toLowerCase();
  return (
    lower === join(iconsDir, 'pugport.ico').toLowerCase() ||
    (VERSIONED.test(basename(icon)) && dirname(lower) === join(app.getPath('userData'), 'brand').toLowerCase())
  );
}

/**
 * Windows takes a taskbar button's icon and name from the Start menu shortcut that carries the window's
 * AppUserModelID; without one, a development build shows Electron's own icon. Keep that shortcut present
 * and pointing at this copy of PugPort (it also makes the app searchable from Start), with the current icon.
 * Desktop shortcuts that already show PugPort's icon get the current one too; nothing else on them changes.
 */
export function ensureTaskbarIdentity(iconsDir: string) {
  if (process.platform !== 'win32') return;
  const icon = versionedAppIcon(iconsDir);
  if (!icon) return;
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const wanted = {
    target: process.execPath,
    args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
    cwd: app.isPackaged ? join(process.execPath, '..') : app.getAppPath(),
    icon,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
    description: 'PugPort',
  };
  // Electron adds its own shortcut, named after the executable's product name, when it shows a notification:
  // "Electron.lnk" in an unbranded development build, and "PugPort.lnk" once the executable carries PugPort's
  // name, replacing ours with one that has neither the app path nor the icon. Both are put right here.
  const links = [join(programs, 'PugPort.lnk'), join(programs, 'Electron.lnk')];
  for (const link of links) {
    const exists = existsSync(link);
    let current: Electron.ShortcutDetails | undefined;
    try {
      current = exists ? shell.readShortcutLink(link) : undefined;
    } catch {
      /* Unreadable: rewrite it below. */
    }
    if (link.endsWith('Electron.lnk') && (!exists || (current && current.appUserModelId !== APP_USER_MODEL_ID)))
      continue;
    if (
      current &&
      current.target === wanted.target &&
      current.args === wanted.args &&
      current.icon === wanted.icon &&
      current.appUserModelId === wanted.appUserModelId
    )
      continue;
    try {
      shell.writeShortcutLink(link, exists ? 'replace' : 'create', wanted);
    } catch {
      /* The icon then falls back to the window's own; never block startup over it. */
    }
  }
  try {
    const desktop = app.getPath('desktop');
    for (const name of readdirSync(desktop)) {
      if (!name.toLowerCase().endsWith('.lnk')) continue;
      const link = join(desktop, name);
      try {
        const current = shell.readShortcutLink(link);
        if (current.icon !== icon && ourIcon(current.icon, iconsDir))
          shell.writeShortcutLink(link, 'update', { ...current, icon, iconIndex: 0 });
      } catch {
        /* Not a readable shortcut; leave it. */
      }
    }
  } catch {
    /* No desktop folder; nothing to update. */
  }
  // The shortcut this app made before it was renamed; Start would list it as "ComboRunner" next to PugPort.
  const renamed = join(programs, 'ComboRunner.lnk');
  try {
    if (existsSync(renamed) && shell.readShortcutLink(renamed).appUserModelId === APP_USER_MODEL_ID)
      rmSync(renamed, { force: true });
  } catch {
    /* Left in place: harmless, and never worth blocking startup. */
  }
}

/**
 * Puts the Start menu shortcut right again whenever something rewrites it while PugPort runs (Electron does on
 * a notification). Returns a function that stops watching.
 */
export function watchTaskbarIdentity(iconsDir: string): () => void {
  if (process.platform !== 'win32') return () => {};
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(programs, (_event, name) => {
      if (name && !/^(PugPort|Electron)\.lnk$/i.test(String(name))) return;
      clearTimeout(timer);
      // Let the other writer finish; our own rewrite triggers one more check, which then finds nothing to do.
      timer = setTimeout(() => ensureTaskbarIdentity(iconsDir), 1500);
    });
    watcher.on('error', () => watcher.close());
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => {};
  }
}

/** Gives one window PugPort's taskbar identity and icon directly, whatever the Start menu holds. */
export function applyTaskbarIdentity(window: BrowserWindow, iconsDir?: string) {
  if (process.platform !== 'win32' || !iconsDir) return;
  const icon = versionedAppIcon(iconsDir);
  if (!icon) return;
  window.setAppDetails({
    appId: APP_USER_MODEL_ID,
    appIconPath: icon,
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
    relaunchDisplayName: 'PugPort',
  });
}
