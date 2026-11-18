import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  downloadsFolder,
  fileBatchCheck,
  openRecordedFile,
  receiveFile,
  transferDeadline,
  type RecordedPeerFile,
} from '../node/peer-files.ts';
import { peerTransferIdleMs, peerTransferLimitMs, safeSegment } from '../../shared/peer-files.ts';
import {
  PeerRefused,
  PeerUnreachable,
  resolvePeer,
  type PeerAddress,
  type PeerFetch,
  type Lookup,
} from './peer-client.ts';

type Connection = { address: PeerAddress; token: string; name: string; fetch?: PeerFetch; lookup?: Lookup };

/** Binary transfers share peer address restrictions, but reset their deadline whenever bytes move. */
async function transfer<T>(
  connection: Connection,
  path: string,
  signal: AbortSignal | undefined,
  size: number,
  action: (url: string, signal: AbortSignal, touch: () => void) => Promise<T>,
): Promise<T> {
  const target = await resolvePeer(connection.address, connection.lookup);
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const abort = new AbortController();
  const deadline = transferDeadline(
    (reason) => abort.abort(new Error(reason === 'idle' ? '设备文件传送已停滞 60 秒。' : '设备文件传送超过总时限。')),
    peerTransferIdleMs,
    peerTransferLimitMs(size),
  );
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  try {
    return await action(`http://${host}:${target.port}${path}`, combined, deadline.touch);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (abort.signal.aborted) throw abort.signal.reason;
    if (error instanceof PeerRefused) throw error;
    throw new PeerUnreachable(error instanceof Error ? error.message : '设备文件传送失败。');
  } finally {
    deadline.close();
  }
}

async function checked(response: Response, connection: Connection, upload = false) {
  if (response.ok) return;
  const reader = response.body?.getReader();
  let detail = '';
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < 1024) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.subarray(0, 1024 - size);
        chunks.push(chunk);
        size += chunk.length;
      }
      const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof json.error === 'string') detail = json.error;
    } catch {
      // Older nodes can return an empty or non-JSON response.
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  if (upload && (response.status === 415 || response.status === 404))
    throw new PeerRefused(
      response.status,
      `请先更新设备「${connection.name}」上的 PugPort：pugport node add <ssh target> --now${detail ? `（${detail}）` : ''}`,
    );
  throw new PeerRefused(response.status, `设备拒绝传送文件（HTTP ${response.status}）${detail ? `：${detail}` : '。'}`);
}

export async function uploadFiles(
  connection: Connection,
  files: RecordedPeerFile[],
  signal?: AbortSignal,
  requestId = randomUUID(),
): Promise<{ path: string }[]> {
  fileBatchCheck(files);
  const sent: { path: string }[] = [];
  for (const file of files) {
    const handle = await openRecordedFile(file);
    try {
      sent.push(
        await transfer(
          connection,
          `/peer/v1/files?${new URLSearchParams({ name: file.name, size: String(file.size), requestId })}`,
          signal,
          file.size,
          async (url, combined, touch) => {
            const source = handle.createReadStream({ autoClose: false });
            async function* body() {
              for await (const chunk of source) {
                touch();
                yield chunk;
              }
            }
            try {
              const response = await (connection.fetch ?? fetch)(url, {
                method: 'PUT',
                headers: {
                  authorization: `Bearer ${connection.token}`,
                  'content-type': 'application/octet-stream',
                  'content-length': String(file.size),
                },
                body: body() as unknown as BodyInit,
                duplex: 'half',
                signal: combined,
                redirect: 'error',
              } as RequestInit);
              await checked(response, connection, true);
              const reader = response.body?.getReader();
              let text = '';
              const decoder = new TextDecoder();
              if (reader)
                for (;;) {
                  const next = await reader.read();
                  if (next.done) break;
                  touch();
                  text += decoder.decode(next.value, { stream: true });
                  if (text.length > 16384) {
                    await reader.cancel();
                    throw new Error('设备的上传回复太长。');
                  }
                }
              text += decoder.decode();
              return z.object({ path: z.string().min(1).max(4000) }).parse(JSON.parse(text));
            } finally {
              source.destroy();
            }
          },
        ),
      );
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return sent;
}

export async function downloadFiles(
  connection: Connection,
  taskId: string,
  files: { id: string; name: string; size: number }[],
  signal?: AbortSignal,
): Promise<string[]> {
  fileBatchCheck(files);
  const paths: string[] = [];
  for (const file of files) {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const path = await transfer(
          connection,
          `/peer/v1/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(file.id)}`,
          signal,
          file.size,
          async (url, combined, touch) => {
            const response = await (connection.fetch ?? fetch)(url, {
              headers: { authorization: `Bearer ${connection.token}` },
              signal: combined,
              redirect: 'error',
            });
            await checked(response, connection);
            if (!response.body) throw new Error('设备没有返回文件。');
            async function* chunks() {
              for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                touch();
                yield chunk;
              }
            }
            try {
              return await receiveFile(
                chunks(),
                file.size,
                join(downloadsFolder(), 'PugPort', safeSegment(connection.name)),
                file.name,
                undefined,
                combined,
              );
            } finally {
              await response.body.cancel().catch(() => {});
            }
          },
        );
        paths.push(path);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (signal?.aborted) throw error;
      }
    }
    if (failure)
      paths.push(`文件 ${safeSegment(file.name)} 下载失败：${failure instanceof Error ? failure.message : '传送失败'}`);
  }
  return paths;
}
