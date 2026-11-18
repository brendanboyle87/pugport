import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { currentHost, type Host } from './host.ts';

/*
 * Owner-only access for secrets. Windows: an explicit ACL for this user and SYSTEM (icacls), nothing inherited.
 * macOS and Linux: mode 0600 for files and 0700 for folders, then a check through the open descriptor that this
 * user owns it and nobody else can read it. Any failure throws; callers report it in their own words.
 */

async function directoryCommand(host: Host, file: string, args: string[], timeout: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await host.run(file, args, { windowsHide: true, timeout: timeout * (attempt + 1) });
    } catch (error) {
      const failure = error as { killed?: boolean; signal?: string; code?: string };
      // execFile has joined the killed child before rejecting. Retry only load-related failures, never ACL denials.
      const transient =
        (failure.killed === true && failure.signal === 'SIGTERM') ||
        ['EBUSY', 'EAGAIN', 'ETXTBSY'].includes(failure.code ?? '');
      if (!transient || attempt === 2) throw error;
    }
  }
}

async function windowsUser(host: Host, timeout: number, retry = false) {
  const system = host.path.join(host.env.SystemRoot || 'C:\\Windows', 'System32');
  const file = host.path.join(system, 'whoami.exe');
  const args = ['/user', '/fo', 'csv', '/nh'];
  const identity = retry
    ? await directoryCommand(host, file, args, timeout)
    : await host.run(file, args, { windowsHide: true, timeout });
  const sid = identity.stdout.match(/S-\d(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('missing user identity');
  return { system, sid };
}

async function checkOwnerOnly(handle: FileHandle, mode: number, host: Host) {
  await handle.chmod(mode);
  const info = await handle.stat();
  const uid = host.uid();
  if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0)
    throw new Error('private file is not owner-only');
}

/**
 * Restrict one file. On Windows, `file` is reset first: an elevated token can create explicit Administrators
 * entries, and /grant:r alone only replaces entries for the two named principals. On POSIX the open `handle`
 * is used when given (so a swapped path cannot be changed instead); otherwise the file is opened without
 * following a link.
 */
export async function restrictFile(
  file: string,
  options: { handle?: FileHandle; timeoutMs?: number } = {},
  host: Host = currentHost(),
): Promise<void> {
  if (host.platform === 'win32') {
    const timeout = options.timeoutMs ?? 5000;
    const { system, sid } = await windowsUser(host, timeout);
    await host.run(host.path.join(system, 'icacls.exe'), [file, '/reset'], { windowsHide: true, timeout });
    await host.run(
      host.path.join(system, 'icacls.exe'),
      [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'],
      { windowsHide: true, timeout },
    );
    return;
  }
  if (options.handle) return checkOwnerOnly(options.handle, 0o600, host);
  const { constants } = host.fs;
  const handle = await host.fs.promises.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('not a file');
    await checkOwnerOnly(handle, 0o600, host);
  } finally {
    await handle.close();
  }
}

/** Folders found or made private by this process, per host. */
const privateFolders = new WeakMap<Host, Set<string>>();

/**
 * Whether the folder's own list is already the one restrictDirectory writes: nothing inherited, full control for
 * this user and SYSTEM, passed on to its contents. Reading it takes milliseconds; any doubt answers no.
 */
async function alreadyPrivate(host: Host, icacls: string, directory: string, sid: string, timeout: number) {
  const saved = host.path.join(host.tmpdir, `pugport-acl-${randomUUID()}.txt`);
  try {
    await host.run(icacls, [directory, '/save', saved], { windowsHide: true, timeout });
    // icacls saves UTF-16: the folder's name, then its list in SDDL.
    const sddl = (await host.fs.promises.readFile(saved)).toString('utf16le').trim().split(/\r?\n/).at(-1) ?? '';
    const list = /^D:([A-Z]*)((?:\([^()]*\))+)$/.exec(sddl.trim());
    if (!list?.[1]!.includes('P')) return false;
    const entries = list[2]!
      .slice(1, -1)
      .split(')(')
      .map((entry) => entry.replace(/;S-1-5-18$/, ';SY'))
      .sort();
    return entries.join('|') === [`A;OICI;FA;;;${sid}`, 'A;OICI;FA;;;SY'].sort().join('|');
  } catch {
    return false;
  } finally {
    await host.fs.promises.rm(saved, { force: true }).catch(() => undefined);
  }
}

/** Restrict a folder and, on Windows, everything later created inside it. */
export async function restrictDirectory(
  directory: string,
  options: { timeoutMs?: number } = {},
  host: Host = currentHost(),
): Promise<void> {
  if (host.platform === 'win32') {
    // Writing the list makes Windows push it to every file below, even when nothing changes: an account folder
    // with tens of thousands of files ran out all three attempts (5 + 10 + 15 s) before every launch. So the list
    // is read first and written only when it differs, and a folder is looked at once per run of the app.
    const known = privateFolders.get(host) ?? new Set<string>();
    privateFolders.set(host, known);
    const key = directory.toLowerCase();
    if (known.has(key)) return;
    const timeout = options.timeoutMs ?? 5000;
    const { system, sid } = await windowsUser(host, timeout, true);
    const icacls = host.path.join(system, 'icacls.exe');
    if (!(await alreadyPrivate(host, icacls, directory, sid, timeout)))
      await directoryCommand(
        host,
        icacls,
        [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`, '*S-1-5-18:(OI)(CI)(F)'],
        timeout,
      );
    known.add(key);
    return;
  }
  const { constants } = host.fs;
  const handle = await host.fs.promises.open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error('not a directory');
    await checkOwnerOnly(handle, 0o700, host);
  } finally {
    await handle.close();
  }
}
