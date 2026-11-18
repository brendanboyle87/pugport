import { currentHost, type Host } from './host.ts';

/**
 * node-pty 1.1.0 publishes its macOS and Linux `spawn-helper` without execute permission and its install scripts
 * never add it, so every terminal launch fails with "posix_spawnp failed". Before a launch, give each helper node-pty
 * may load (the same folders, including the unpacked copy beside an asar archive) execute permission wherever it
 * already has read permission. Returns false when a helper stays unexecutable, for example in a read-only bundle;
 * the launch then fails with its usual error. A helper that is a symbolic link is left alone: changing it would change
 * its target, which may lie outside the package.
 */
export function ensurePtyHelperExecutable(
  packageRoot: string,
  arch: string = process.arch,
  host: Host = currentHost(),
): boolean {
  if (host.platform === 'win32') return true;
  // A root already inside the unpacked folder must not gain a second ".unpacked".
  const root = packageRoot.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
  let executable = true;
  for (const folder of ['build/Release', 'build/Debug', `prebuilds/${host.platform}-${arch}`]) {
    const helper = host.path.join(root, folder, 'spawn-helper');
    let mode: number;
    try {
      const info = host.fs.lstatSync(helper);
      if (!info.isFile()) continue;
      mode = info.mode & 0o777;
    } catch {
      continue;
    }
    const wanted = mode | ((mode & 0o444) >> 2);
    if (wanted === mode) continue;
    try {
      host.fs.chmodSync(helper, wanted);
    } catch {
      executable = false;
    }
  }
  return executable;
}
