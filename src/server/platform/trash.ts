import { powerShellValue, runPowerShell } from './powershell.ts';
import { randomUUID } from 'node:crypto';
import { currentHost, type Host } from './host.ts';
import { systemTrashName } from '../../shared/trash.ts';

/*
 * Moving files to the system's Recycle Bin / Trash, never deleting them permanently. Whatever cannot go there
 * (another disk, a network drive, a full Recycle Bin) is refused and reported instead.
 *  - Windows: SHFileOperation through PowerShell (unchanged from recycle-bin.ts).
 *  - macOS: NSFileManager trashItemAtURL through JavaScript for Automation (osascript ships with macOS).
 *  - Linux: the freedesktop.org Trash specification in plain Node (Ubuntu Server has neither gio nor trash-put):
 *    reserve info/<name>.trashinfo with O_EXCL, then rename the item into files/<name>. Only items on the same
 *    file system as the home Trash are accepted; nothing is ever copied and then deleted.
 */

export type TrashResult = { path: string; ok: boolean; reason?: string };

/** What the user calls it: 回收站 on Windows and Linux desktops, 废纸篓 on macOS. */
export function trashName(host: Host = currentHost()): string {
  return systemTrashName(host.platform);
}

export async function moveToTrash(
  paths: string[],
  signal?: AbortSignal,
  host: Host = currentHost(),
): Promise<TrashResult[]> {
  if (host.platform === 'win32') return windowsRecycle(paths, signal, host);
  if (host.platform === 'darwin') return macTrash(paths, signal, host);
  if (host.platform === 'linux') return freedesktopTrash(paths, signal, host);
  throw new Error('这台电脑的系统不支持移到回收站。');
}

/* ---------- Windows ---------- */

async function windowsRecycle(paths: string[], signal: AbortSignal | undefined, host: Host): Promise<TrashResult[]> {
  const { path, fs } = host;
  const id = randomUUID();
  const input = path.join(host.tmpdir, `comborunner-recycle-${id}.json`);
  const output = path.join(host.tmpdir, `comborunner-recycle-${id}.out.json`);
  await fs.promises.writeFile(input, JSON.stringify(paths), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await runPowerShell(recycleScript(input, output), '回收站操作未完成{0}', signal, 120_000, host);
    const results = JSON.parse((await fs.promises.readFile(output, 'utf8')).replace(/^\uFEFF/, '')) as
      TrashResult[] | TrashResult;
    return Array.isArray(results) ? results : [results];
  } finally {
    await fs.promises.rm(input, { force: true }).catch(() => {});
    await fs.promises.rm(output, { force: true }).catch(() => {});
  }
}

export function recycleScript(input: string, output: string) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ComboRunnerRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Op { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref Op op);
  // FO_DELETE with FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING.
  public static int Recycle(string path) {
    var op = new Op { wFunc = 3, pFrom = path + "\\0\\0", fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000 };
    int code = SHFileOperation(ref op);
    return op.fAnyOperationsAborted ? -1 : code;
  }
}
"@
# Windows PowerShell 5.1 emits a JSON array as one object; foreach over the variable enumerates it.
$paths = Get-Content -LiteralPath ${powerShellValue(input)} -Raw -Encoding UTF8 | ConvertFrom-Json
$bins = @{}
function Bin($letter) {
  if ($bins.ContainsKey($letter)) { return $bins[$letter] }
  $info = @{ ok = $false; capacity = [long]0; reason = '' }
  $drive = [IO.DriveInfo]::new($letter)
  if ($drive.DriveType -ne 'Fixed') { $info.reason = '所在磁盘没有回收站（网络盘或移动盘）' }
  else {
    $info.ok = $true
    $volume = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $letter.TrimEnd('\\') + "'") -ErrorAction SilentlyContinue
    if ($volume -and $volume.DeviceID -match '\\{[0-9a-fA-F-]+\\}') {
      $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\' + $Matches[0]
      $settings = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
      if ($settings -and $settings.NukeOnDelete -eq 1) { $info.ok = $false; $info.reason = '这个磁盘的回收站已关闭（删除会直接永久删除）' }
      elseif ($settings -and $settings.MaxCapacity) { $info.capacity = [long]$settings.MaxCapacity * 1MB }
    }
  }
  $bins[$letter] = $info
  return $info
}
$results = foreach ($path in $paths) {
  try {
    $item = Get-Item -LiteralPath $path -Force
    $bin = Bin ([IO.Path]::GetPathRoot($item.FullName))
    if (-not $bin.ok) { [pscustomobject]@{ path = $path; ok = $false; reason = $bin.reason }; continue }
    $size = if ($item.PSIsContainer) { (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } else { $item.Length }
    if ($bin.capacity -gt 0 -and [long]$size -gt $bin.capacity) {
      [pscustomobject]@{ path = $path; ok = $false; reason = '超过回收站容量，Windows 会改为永久删除，已跳过' }; continue
    }
    $code = [ComboRunnerRecycle]::Recycle($item.FullName)
    if ($code -eq 0) { [pscustomobject]@{ path = $path; ok = $true } }
    else { [pscustomobject]@{ path = $path; ok = $false; reason = "Windows 返回错误 $code（可能被占用或已取消）" } }
  } catch {
    [pscustomobject]@{ path = $path; ok = $false; reason = $_.Exception.Message }
  }
}
ConvertTo-Json -InputObject @($results) -Depth 3 | Set-Content -LiteralPath ${powerShellValue(output)} -Encoding UTF8
`;
}

/* ---------- macOS ---------- */

/** Reads a JSON list of paths from the file named by its argument; prints one result per path as JSON. */
export const macTrashScript = `ObjC.import('Foundation');
function run(argv) {
  var text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  var paths = JSON.parse(ObjC.unwrap(text));
  var manager = $.NSFileManager.defaultManager;
  var results = [];
  for (var i = 0; i < paths.length; i++) {
    var error = $();
    var ok = false;
    var reason = '';
    try {
      ok = manager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(paths[i]), null, error);
    } catch (e) {
      reason = String(e);
    }
    if (!ok && !reason) {
      try {
        reason = ObjC.unwrap(error.localizedDescription) || '';
      } catch (e) {}
    }
    results.push(ok ? { path: paths[i], ok: true } : { path: paths[i], ok: false, reason: reason });
  }
  return JSON.stringify(results);
}`;

async function macTrash(paths: string[], signal: AbortSignal | undefined, host: Host): Promise<TrashResult[]> {
  const { path, fs } = host;
  const input = path.join(host.tmpdir, `pugport-trash-${randomUUID()}.json`);
  await fs.promises.writeFile(input, JSON.stringify(paths), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    const { stdout } = await host.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macTrashScript, input], {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    const results = JSON.parse(stdout.trim()) as TrashResult[];
    if (!Array.isArray(results)) throw new Error('unexpected osascript output');
    return results.map((result) =>
      result.ok ? { path: result.path, ok: true } : { ...result, reason: result.reason || '未能移到废纸篓' },
    );
  } catch (error) {
    throw new Error(`废纸篓操作未完成：${error instanceof Error ? error.message.slice(-300) : String(error)}`);
  } finally {
    await fs.promises.rm(input, { force: true }).catch(() => {});
  }
}

/* ---------- Linux (freedesktop.org Trash specification 1.0) ---------- */

/** Path= is percent-encoded like a URI path (RFC 2396); "/" stays as it is. */
export function encodeTrashPath(path: string): string {
  return path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/');
}

/** The .trashinfo text: original location and local deletion time (YYYY-MM-DDThh:mm:ss, no time zone). */
export function trashInfo(path: string, deletedAt: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  const date = `${deletedAt.getFullYear()}-${two(deletedAt.getMonth() + 1)}-${two(deletedAt.getDate())}`;
  const time = `${two(deletedAt.getHours())}:${two(deletedAt.getMinutes())}:${two(deletedAt.getSeconds())}`;
  return `[Trash Info]\nPath=${encodeTrashPath(path)}\nDeletionDate=${date}T${time}\n`;
}

/** The home Trash: $XDG_DATA_HOME/Trash, by default ~/.local/share/Trash. */
export function homeTrash(host: Host = currentHost()): string {
  const data = host.env.XDG_DATA_HOME;
  return host.path.join(
    data && host.path.isAbsolute(data) ? data : host.path.join(host.home, '.local', 'share'),
    'Trash',
  );
}

/** A name inside the Trash short enough for "<name>.trashinfo" (file names are at most 255 bytes). */
function trashEntryName(name: string, attempt: number): string {
  let base = name;
  while (Buffer.byteLength(base) > 200) base = base.slice(0, -1);
  if (attempt === 1) return base;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? `${base.slice(0, dot)}.${attempt}${base.slice(dot)}` : `${base}.${attempt}`;
}

async function freedesktopTrash(
  paths: string[],
  signal: AbortSignal | undefined,
  host: Host,
  now: () => Date = () => new Date(),
): Promise<TrashResult[]> {
  const { path, fs } = host;
  const trash = homeTrash(host);
  const files = path.join(trash, 'files');
  const info = path.join(trash, 'info');
  for (const folder of [trash, files, info]) {
    await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
    const entry = await fs.promises.lstat(folder);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('回收站文件夹无效（不是普通文件夹）。');
  }
  const device = (await fs.promises.stat(files)).dev;
  const results: TrashResult[] = [];
  for (const item of paths) {
    if (signal?.aborted) {
      results.push({ path: item, ok: false, reason: '已取消' });
      continue;
    }
    results.push(await trashOne(item, { files, info, device, host, now }));
  }
  return results;
}

async function trashOne(
  item: string,
  where: { files: string; info: string; device: number; host: Host; now: () => Date },
): Promise<TrashResult> {
  const { path, fs } = where.host;
  let entry;
  try {
    entry = await fs.promises.lstat(item);
  } catch {
    return { path: item, ok: false, reason: '不存在' };
  }
  // A rename across file systems fails; the spec's copy-then-delete fallback is never used.
  if (entry.dev !== where.device)
    return { path: item, ok: false, reason: '不在主文件夹所在的磁盘上，无法移到回收站；没有删除它' };
  const original = path.resolve(item);
  for (let attempt = 1; attempt < 1000; attempt++) {
    const name = trashEntryName(path.basename(original), attempt);
    const infoFile = path.join(where.info, `${name}.trashinfo`);
    let handle;
    try {
      handle = await fs.promises.open(infoFile, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { path: item, ok: false, reason: `无法在回收站登记：${(error as NodeJS.ErrnoException).code ?? error}` };
    }
    try {
      await handle.writeFile(trashInfo(original, where.now()), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const target = path.join(where.files, name);
    // rename() replaces an existing file, so a stray entry without its .trashinfo is never overwritten.
    const taken = await fs.promises.lstat(target).then(
      () => true,
      () => false,
    );
    if (taken) {
      await fs.promises.unlink(infoFile).catch(() => {});
      continue;
    }
    try {
      await fs.promises.rename(original, target);
      return { path: item, ok: true };
    } catch (error) {
      await fs.promises.unlink(infoFile).catch(() => {});
      const code = (error as NodeJS.ErrnoException).code;
      return {
        path: item,
        ok: false,
        reason:
          code === 'EXDEV'
            ? '不在主文件夹所在的磁盘上，无法移到回收站；没有删除它'
            : `未能移到回收站（${code ?? String(error)}）`,
      };
    }
  }
  return { path: item, ok: false, reason: '回收站里同名的项目太多' };
}

/** For tests: the Linux implementation with a fixed clock. */
export const freedesktopTrashForTest = freedesktopTrash;
