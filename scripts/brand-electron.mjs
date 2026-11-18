// Gives the development Electron executable PugPort's icon and name, as packaging does for releases.
// Windows takes the taskbar icon, notification shortcut and Start entry from the executable, so without this a
// development build keeps showing Electron's icon after every restart. Safe to run repeatedly, also while PugPort
// or a pugport-mcp helper is running from the executable (see below); skipped on other platforms.
import { copyFileSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Returns instead of exiting: the build imports this, and an exit here once skipped publishing the UI.
export async function brandElectron() {
  if (process.platform !== 'win32') return;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(import.meta.url);
  const exe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const icon = join(root, 'assets', 'icons', 'pugport.ico');
  const retired = `${basename(exe)}.old-`;

  // Copies swapped out earlier stay until nothing runs them any more; clear whichever are free now.
  for (const name of readdirSync(dirname(exe)))
    if (name.startsWith(retired))
      try {
        rmSync(join(dirname(exe), name));
      } catch {
        /* Still running somewhere; a later run removes it. */
      }

  const { NtExecutable, NtExecutableResource, Resource } = require('resedit');
  const current = (() => {
    try {
      const resources = NtExecutableResource.from(NtExecutable.from(readFileSync(exe)));
      const [info] = Resource.VersionInfo.fromEntries(resources.entries);
      const [language] = info.getAllLanguagesForStringValues();
      return info.getStringValues(language).ProductName;
    } catch {
      return undefined;
    }
  })();
  // The icon can change while the name stays the same; a stamp beside the executable records which icon it carries.
  const stamp = join(dirname(exe), '.pugport-icon.sha256');
  const iconHash = createHash('sha256').update(readFileSync(icon)).digest('hex');
  const stamped = (() => {
    try {
      return readFileSync(stamp, 'utf8').trim();
    } catch {
      return '';
    }
  })();
  if (current === 'PugPort' && stamped === iconHash) return;

  const { resedit } = await import('@electron/packager/resedit');
  const brand = (file) =>
    resedit(file, {
      iconPath: icon,
      productName: 'PugPort',
      win32Metadata: { FileDescription: 'PugPort', InternalName: 'PugPort' },
    });
  try {
    try {
      await brand(exe);
    } catch (error) {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      // PugPort or a Claude session's pugport-mcp helper is running from the executable. Windows refuses to rewrite a
      // running executable but lets it be renamed, so brand a copy and swap it in: running processes keep the old
      // file, every later start gets the new one.
      const fresh = `${exe}.branding`;
      copyFileSync(exe, fresh);
      await brand(fresh);
      const old = join(dirname(exe), `${retired}${Date.now()}`);
      renameSync(exe, old);
      try {
        renameSync(fresh, exe);
      } catch (swapError) {
        renameSync(old, exe); // never leave the project without its Electron
        throw swapError;
      }
    }
    writeFileSync(stamp, iconHash);
    console.log('Development Electron now carries the PugPort icon and name.');
  } catch (error) {
    console.warn(`Could not brand Electron yet (${error.code ?? error.message}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await brandElectron();
