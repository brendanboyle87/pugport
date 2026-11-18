import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electronModule } from './helpers/electron-harness.ts';

type Link = {
  target?: string;
  args?: string;
  cwd?: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId?: string;
  description?: string;
};

/** A fake Electron with real files: shortcuts are JSON files, so existence checks and folder listings behave as on disk. */
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pugport-taskbar-identity-'));
  const appData = join(root, 'Roaming');
  const userData = join(appData, 'ComboRunner');
  const desktop = join(root, 'Desktop');
  const programs = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const iconsDir = join(root, 'repo', 'assets', 'icons');
  for (const dir of [programs, desktop, iconsDir, userData]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(iconsDir, 'pugport.ico'), 'white tile');
  const writes: string[] = [];
  const read = (path: string): Link => JSON.parse(readFileSync(path, 'utf8'));
  const electron = {
    app: {
      isPackaged: false,
      getAppPath: () => join(root, 'repo'),
      getPath: (name: string) => ({ appData, userData, desktop })[name]!,
    },
    shell: {
      readShortcutLink: (path: string) => read(path),
      writeShortcutLink: (path: string, operation: string, details: Link) => {
        writes.push(`${operation} ${path}`);
        const merged = operation === 'update' ? { ...read(path), ...details } : details;
        writeFileSync(path, JSON.stringify(merged));
        return true;
      },
    },
  };
  const module = await electronModule('src/electron/taskbar-identity.ts', electron, {
    process: { platform: 'win32', execPath: 'C:\\electron\\electron.exe', env: {} },
  });
  return {
    root,
    programs,
    desktop,
    iconsDir,
    userData,
    writes,
    read,
    module,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('shortcuts point at a hash-named copy of the icon, so Windows cannot show a cached old picture', async () => {
  const h = await harness();
  try {
    h.module.ensureTaskbarIdentity(h.iconsDir);
    const start = h.read(join(h.programs, 'PugPort.lnk'));
    assert.match(start.icon!, /[\\/]brand[\\/]pugport-[0-9a-f]{12}\.ico$/);
    assert.equal(readFileSync(start.icon!, 'utf8'), 'white tile');
    assert.equal(start.args, `"${join(h.root, 'repo')}"`);
    assert.equal(start.appUserModelId, 'ComboRunner.App');

    // A new picture gets a new name; the old copy goes away.
    writeFileSync(join(h.iconsDir, 'pugport.ico'), 'another tile');
    h.module.ensureTaskbarIdentity(h.iconsDir);
    const next = h.read(join(h.programs, 'PugPort.lnk'));
    assert.notEqual(next.icon, start.icon);
    assert.equal(readFileSync(next.icon!, 'utf8'), 'another tile');
    assert.deepEqual(readdirSync(join(h.userData, 'brand')), [next.icon!.split(/[\\/]/).pop()]);
  } finally {
    h.done();
  }
});

test('a Start menu shortcut Electron rewrote for a notification gets the app path and icon back', async () => {
  const h = await harness();
  try {
    h.module.ensureTaskbarIdentity(h.iconsDir);
    const ours = h.read(join(h.programs, 'PugPort.lnk'));
    // What Electron writes: the bare executable, its own folder, no icon.
    writeFileSync(
      join(h.programs, 'PugPort.lnk'),
      JSON.stringify({
        target: 'C:\\electron\\electron.exe',
        args: '',
        cwd: 'C:\\electron',
        icon: '',
        appUserModelId: 'ComboRunner.App',
      }),
    );
    h.module.ensureTaskbarIdentity(h.iconsDir);
    assert.deepEqual(h.read(join(h.programs, 'PugPort.lnk')), ours);
    // Nothing to do when it is already right.
    const before = h.writes.length;
    h.module.ensureTaskbarIdentity(h.iconsDir);
    assert.equal(h.writes.length, before);
  } finally {
    h.done();
  }
});

test('desktop shortcuts that show the PugPort icon get the current one; other shortcuts are left alone', async () => {
  const h = await harness();
  try {
    const launcher = {
      target: 'C:\\Windows\\System32\\wscript.exe',
      args: '"C:\\repo\\.data\\launchers\\start-pugport.vbs"',
      icon: join(h.iconsDir, 'pugport.ico'),
      iconIndex: 0,
    };
    writeFileSync(join(h.desktop, 'PugPort.lnk'), JSON.stringify(launcher));
    const other = { target: 'C:\\Other\\other.exe', icon: 'C:\\Other\\other.ico', iconIndex: 0 };
    writeFileSync(join(h.desktop, 'Other.lnk'), JSON.stringify(other));
    writeFileSync(join(h.desktop, 'notes.txt'), 'not a shortcut');
    h.module.ensureTaskbarIdentity(h.iconsDir);
    const updated = h.read(join(h.desktop, 'PugPort.lnk'));
    assert.equal(updated.icon, h.read(join(h.programs, 'PugPort.lnk')).icon);
    assert.equal(updated.target, launcher.target);
    assert.equal(updated.args, launcher.args);
    assert.deepEqual(h.read(join(h.desktop, 'Other.lnk')), other);
    assert.equal(readFileSync(join(h.desktop, 'notes.txt'), 'utf8'), 'not a shortcut');
  } finally {
    h.done();
  }
});

test('the watcher repairs the Start menu shortcut after another writer replaces it', async () => {
  const h = await harness();
  try {
    h.module.ensureTaskbarIdentity(h.iconsDir);
    const ours = h.read(join(h.programs, 'PugPort.lnk'));
    const stop = h.module.watchTaskbarIdentity(h.iconsDir);
    try {
      writeFileSync(
        join(h.programs, 'PugPort.lnk'),
        JSON.stringify({ target: 'C:\\electron\\electron.exe', args: '', icon: '', appUserModelId: 'ComboRunner.App' }),
      );
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && h.read(join(h.programs, 'PugPort.lnk')).args !== ours.args)
        await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(h.read(join(h.programs, 'PugPort.lnk')), ours);
    } finally {
      stop();
    }
  } finally {
    h.done();
  }
});

test('nothing happens off Windows', async () => {
  const h = await harness();
  try {
    const mac = await electronModule(
      'src/electron/taskbar-identity.ts',
      { app: { getPath: () => h.root }, shell: {} },
      { process: { platform: 'darwin', env: {} } },
    );
    mac.ensureTaskbarIdentity(h.iconsDir);
    assert.equal(existsSync(join(h.programs, 'PugPort.lnk')), false);
    assert.equal(typeof mac.watchTaskbarIdentity(h.iconsDir), 'function');
  } finally {
    h.done();
  }
});
