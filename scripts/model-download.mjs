import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function reportProgress(phase, message, extra = {}) {
  process.stdout.write(`PUGPORT_INSTALL_PROGRESS ${JSON.stringify({ phase, message, ...extra })}\n`);
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Only a complete, verified file becomes visible under its final name. */
export async function downloadVerifiedFile(destination, urls, sha256, { fetchImpl = fetch } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Expected a pinned SHA-256 digest.');
  if (existsSync(destination) && (await digestFile(destination)) === sha256) return;
  mkdirSync(dirname(destination), { recursive: true });
  let failure;
  for (const url of urls) {
    const partial = `${destination}.${randomUUID()}.part`;
    try {
      reportProgress('downloading', '正在下载组件，完成后校验完整性。');
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length'));
      const hash = createHash('sha256');
      const body = Readable.fromWeb(response.body);
      let received = 0,
        reportedAt = 0;
      body.on('data', (chunk) => {
        hash.update(chunk);
        received += chunk.length;
        if (Date.now() - reportedAt > 2000) {
          reportedAt = Date.now();
          reportProgress('downloading', '正在下载组件。', {
            receivedBytes: received,
            ...(total > 0 ? { totalBytes: total } : {}),
          });
        }
      });
      await pipeline(body, createWriteStream(partial, { flags: 'wx' }));
      reportProgress('verifying', '正在校验下载文件。');
      if (hash.digest('hex') !== sha256) throw new Error('Downloaded file checksum mismatch.');
      renameSync(partial, destination);
      return;
    } catch (error) {
      failure = error;
    } finally {
      rmSync(partial, { force: true });
    }
  }
  throw new Error(`Component download failed: ${failure?.message ?? failure}`);
}

export function validateArchiveEntries(entries) {
  for (const raw of entries) {
    const path = raw.replaceAll('\\', '/').replace(/\/$/, '');
    if (
      !path ||
      /^[\/]/.test(path) ||
      /^[a-z]:/i.test(path) ||
      /[\x00-\x1f]/.test(path) ||
      path.split('/').some((part) => part === '..' || part === '.')
    )
      throw new Error('Unsafe path in component archive.');
  }
}

/** Both GNU tar and Windows bsdtar expose the Unix entry type in verbose listings. */
export function validateArchiveTypes(listing) {
  for (const line of listing.split(/\r?\n/).filter(Boolean)) {
    if (!/^[d-][rwxstST-]{9}\s/.test(line))
      throw new Error('Links and special files are not allowed in component archives.');
  }
}
