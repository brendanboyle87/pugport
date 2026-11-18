import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { restrictFile } from './platform/secure-file.ts';

async function currentText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Restrict access (Windows ACL, POSIX 0600 with an owner check) before writing secrets, and retain it on replacement. */
export async function writePrivateConfig(
  file: string,
  contents: string,
  expectedText: string,
  helperTimeoutMs = 5000,
): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `private-config.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    try {
      // Restrict the empty temporary file, so the secret never exists with wider access.
      await restrictFile(temporary, { handle, timeoutMs: helperTimeoutMs });
    } catch {
      throw new Error('无法限制凭据文件访问权限，原文件未修改。');
    }
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
    if ((await currentText(file)) !== expectedText) throw new Error('配置同时发生变化，请重试；原文件未覆盖。');
    await rename(temporary, file);
  } finally {
    if (!closed) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
