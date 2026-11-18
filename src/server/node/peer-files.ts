import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, stat, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, parse } from 'node:path';
import {
  safeSegment,
  maxPeerFileSize,
  maxPeerFiles,
  maxPeerFilesSize,
  peerFileReserveBytes,
  peerTransferIdleMs,
  peerTransferMaxMs,
} from '../../shared/peer-files.ts';
import { currentHost, type Host } from '../platform/host.ts';
import { userFolders } from '../platform/dirs.ts';
import { protectedInside, protectedRoots, protectionKey } from '../platform/protected-roots.ts';
import { underTest, testDirectory } from '../platform/under-test.ts';
import { fileIdentity } from '../platform/file-identity.ts';

export { safeSegment } from '../../shared/peer-files.ts';
export type RecordedPeerFile = { id: string; name: string; path: string; size: number; dev: string; ino: string };

export function downloadsFolder(): string {
  return underTest() ? join(testDirectory(), 'Downloads') : userFolders().downloads;
}

export function nodeReceivedFolder(mainName: string, host: Host = currentHost()): string {
  return join(underTest() ? testDirectory() : host.home, 'PugPort', 'Received', `from-${safeSegment(mainName)}`);
}

function fileReadError(error: unknown, path: string, host: Host): unknown {
  if (host.platform === 'darwin' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? ''))
    return new Error(
      `macOS 阻止读取文件「${path}」。请打开「系统设置 → 隐私与安全性 → 完全磁盘访问权限」，添加 ${process.execPath}，然后重试。`,
    );
  return error;
}

export function fileSizeCheck(size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxPeerFileSize) throw new Error('每个文件不能超过 2 GiB。');
}

export function fileBatchCheck(files: readonly { size: number }[]) {
  for (const file of files) fileSizeCheck(file.size);
  if (files.length > maxPeerFiles || files.reduce((sum, file) => sum + file.size, 0) > maxPeerFilesSize)
    throw new Error('每条任务最多传送 16 个文件，总大小不超过 4 GiB。');
}

export async function validateFile(path: string, host: Host = currentHost()): Promise<RecordedPeerFile> {
  try {
    if (path.length > 4000 || !isAbsolute(path) || /[\0\r\n]/.test(path))
      throw new Error('请填写绝对文件路径（最多 4000 个字符）。');
    const resolved = await realpath(path);
    const roots = protectedRoots(host);
    const key = protectionKey(resolved, host);
    const allowed = roots.allowedInside.some((root) => protectedInside(resolved, root, host));
    if (
      roots.systemNames.test(resolved) ||
      (!allowed &&
        roots.system.some((root) => key === protectionKey(root, host) || protectedInside(resolved, root, host)))
    )
      throw new Error('受保护文件夹中的文件不能传送。');
    const info = await stat(resolved, { bigint: true });
    if (!info.isFile()) throw new Error('请选择普通文件。');
    fileSizeCheck(Number(info.size));
    const identity = fileIdentity(info);
    return {
      id: randomUUID(),
      name: safeSegment(basename(resolved)),
      path: resolved,
      size: Number(info.size),
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
    };
  } catch (error) {
    throw fileReadError(error, path, host);
  }
}

export async function validateFiles(paths: readonly string[]): Promise<RecordedPeerFile[]> {
  if (paths.length > maxPeerFiles) throw new Error('每条任务最多传送 16 个文件。');
  const files = await Promise.all(paths.map((path) => validateFile(path)));
  fileBatchCheck(files);
  return files;
}

export async function openRecordedFile(file: RecordedPeerFile, host: Host = currentHost()): Promise<FileHandle> {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    throw fileReadError(error, file.path, host);
  });
  try {
    const info = await handle.stat({ bigint: true });
    const identity = fileIdentity(info);
    if (
      !info.isFile() ||
      identity.dev.toString() !== file.dev ||
      identity.ino.toString() !== file.ino ||
      info.size !== BigInt(file.size)
    )
      throw new Error('任务完成后文件已改变。');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Transfers abort when idle or when the total transfer deadline expires. */
export function transferDeadline(
  abort: (reason: 'idle' | 'total') => void,
  idleMs = peerTransferIdleMs,
  maxMs = peerTransferMaxMs,
) {
  let timer: NodeJS.Timeout;
  const maxTimer = setTimeout(() => abort('total'), maxMs);
  maxTimer.unref();
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort('idle'), idleMs);
    timer.unref();
  };
  touch();
  return {
    touch,
    close: () => {
      clearTimeout(timer);
      clearTimeout(maxTimer);
    },
  };
}

let inFlightBytes = 0;

export async function receiveFile(
  source: AsyncIterable<Uint8Array>,
  size: number,
  folder: string,
  name: string,
  available: typeof statfs = statfs,
  signal?: AbortSignal,
): Promise<string> {
  fileSizeCheck(size);
  signal?.throwIfAborted();
  await mkdir(folder, { recursive: true });
  await Promise.all(
    (await readdir(folder, { withFileTypes: true })).map(async (entry) => {
      if (!entry.isFile() || !/^\.pugport-.+\.part$/.test(entry.name)) return;
      const path = join(folder, entry.name);
      try {
        if ((await stat(path)).mtimeMs < Date.now() - 86400_000) await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }),
  );
  const space = await available(folder);
  if (Number(space.bavail) * Number(space.bsize) < inFlightBytes + size + peerFileReserveBytes)
    throw new Error('可用空间不足（需要保留 2 GiB 空间）。');
  inFlightBytes += size;
  let temporary: string | undefined;
  let handle: FileHandle | undefined;
  let final: string | undefined;
  let reserved = false;
  let committed = false;
  try {
    signal?.throwIfAborted();
    temporary = join(folder, `.pugport-${randomUUID()}.part`);
    handle = await open(temporary, 'wx', 0o600);
    let count = 0;
    const iterator = source[Symbol.asyncIterator]();
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason ?? new Error('文件传送已取消。'));
          else
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('文件传送已取消。')), {
              once: true,
            });
        })
      : undefined;
    aborted?.catch(() => {});
    try {
      for (;;) {
        const next = aborted ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
        if (next.done) break;
        signal?.throwIfAborted();
        const chunk = next.value;
        count += chunk.byteLength;
        if (count > size) throw new Error('文件大小不匹配。');
        await handle.writeFile(chunk);
      }
    } finally {
      void iterator.return?.().catch(() => {});
    }
    signal?.throwIfAborted();
    if (count !== size) throw new Error('文件大小不匹配。');
    await handle.close();
    handle = undefined;
    const safe = safeSegment(name);
    const parts = parse(safe);
    for (let n = 0; ; n++) {
      final = join(folder, n ? `${parts.name}-${n}${parts.ext}` : safe);
      try {
        const reservation = await open(final, 'wx', 0o600);
        await reservation.close();
        reserved = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    signal?.throwIfAborted();
    await rename(temporary, final);
    reserved = false;
    committed = true;
    return final;
  } finally {
    inFlightBytes = Math.max(0, inFlightBytes - size);
    await handle?.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
    if ((reserved || (committed && signal?.aborted)) && final) await unlink(final).catch(() => {});
  }
}

export const sendFileLine = /^PUGPORT_SEND_FILE: ((?:\/|[A-Za-z]:[\\/])[^\r\n]+)\r?$/gm;
export const stripSendFileLines = (text: string) => {
  const stripped = text.replace(/^PUGPORT_SEND_FILE: (?:\/|[A-Za-z]:[\\/])[^\r\n]+\r?\n?/gm, '');
  // No run of blank lines where the file lines were, nor after the answer: the main adds its own file lines below it.
  return stripped === text ? text : stripped.replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n').trimEnd();
};

export async function collectReturnFiles(outputs: readonly string[], untrusted: boolean) {
  if (untrusted) return { files: [], refused: [] };
  const paths = [
    ...new Set(
      outputs.flatMap((output) => [...output.matchAll(sendFileLine)].map((match) => match[1]!.replace(/\r$/, ''))),
    ),
  ];
  const checked = await Promise.allSettled(
    paths.map(async (path) => {
      const file = await validateFile(path);
      const handle = await openRecordedFile(file);
      await handle.close();
      return file;
    }),
  );
  const files: RecordedPeerFile[] = [];
  const refused: string[] = [];
  for (const [index, result] of checked.entries()) {
    try {
      if (result.status === 'rejected') throw result.reason;
      fileBatchCheck([...files, result.value]);
      files.push(result.value);
    } catch (error) {
      refused.push(
        `${safeSegment(basename(paths[index]!))}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { files, refused };
}
