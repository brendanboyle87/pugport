import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { FrameSignature, MediaDecoder } from './media-decoder.ts';

const signatureVersion = 'sharp-ffmpeg-rgb72-dhash-v1';
const maxEntries = 50_000;

async function identity(path: string, time: number, signal: AbortSignal, decoder: string, expectedOriginal?: string) {
  signal.throwIfAborted();
  const canonical = await realpath(path);
  const info = await stat(canonical, { bigint: true });
  if (!info.isFile()) throw new Error('Media frame input is not a regular file.');
  if (expectedOriginal && [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') !== expectedOriginal)
    throw new Error('Original media changed after local staging.');
  signal.throwIfAborted();
  return createHash('sha256')
    .update(
      JSON.stringify([
        signatureVersion,
        decoder,
        process.platform === 'win32' ? canonical.toLowerCase() : canonical,
        String(info.dev),
        String(info.ino),
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
        time,
      ]),
    )
    .digest('hex');
}

function isSignature(value: unknown, time: number): value is FrameSignature {
  if (!value || typeof value !== 'object') return false;
  const frame = value as FrameSignature;
  return (
    frame.time === time &&
    /^[a-f\d]{16}$/i.test(frame.hash) &&
    Number.isFinite(frame.texture) &&
    frame.texture >= 0 &&
    Array.isArray(frame.colours) &&
    frame.colours.length === 12 &&
    frame.colours.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

/** Waiting callers own only their wait; the decoder remains owned by its original signal. */
async function waitForFlight(promise: Promise<FrameSignature>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const settled = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(settled, settled);
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
}

/** Tiny signatures only, bounded on disk. Never stores decoded frames or permits recycling a file. */
export function withFrameSignatureCache(
  decoder: MediaDecoder,
  db: DatabaseSync,
  expectedOriginal?: (path: string) => string | undefined,
): MediaDecoder {
  db.exec(`CREATE TABLE IF NOT EXISTS frame_signatures (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, saved INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS frame_signatures_saved ON frame_signatures(saved);`);
  const flights = new Map<string, { signal: AbortSignal; promise: Promise<FrameSignature> }>();
  let inserted = 0;
  return {
    description: decoder.description,
    cacheIdentity: decoder.cacheIdentity,
    image: (path, signal) => decoder.image(path, signal),
    probe: (path, signal) => decoder.probe(path, signal),
    ...(decoder.compareImages
      ? { compareImages: (a: string, b: string, signal: AbortSignal) => decoder.compareImages!(a, b, signal) }
      : {}),
    async frame(path, time, signal) {
      if (!Number.isFinite(time) || time < 0) throw new Error('Invalid frame position.');
      const decoderIdentity = decoder.cacheIdentity ?? decoder.description;
      const trustedOriginal = expectedOriginal?.(path);
      while (true) {
        const key = await identity(path, time, signal, decoderIdentity, trustedOriginal);
        const row = db.prepare('SELECT data FROM frame_signatures WHERE key=?').get(key) as
          { data: string } | undefined;
        if (row) {
          try {
            const frame: unknown = JSON.parse(row.data);
            if (isSignature(frame, time)) {
              signal.throwIfAborted();
              return frame;
            }
          } catch {
            signal.throwIfAborted();
          }
          db.prepare('DELETE FROM frame_signatures WHERE key=?').run(key);
        }
        const inFlight = flights.get(key);
        if (inFlight?.signal === signal) return inFlight.promise;
        if (inFlight) {
          await waitForFlight(inFlight.promise, signal);
          // Recheck the original and the cache, including after owner cancellation/failure.
          // Every waiter re-enters admission, so a retry has one owner too.
          continue;
        }
        const promise = (async () => {
          const frame = await decoder.frame(path, time, signal);
          signal.throwIfAborted();
          if (
            isSignature(frame, time) &&
            key === (await identity(path, time, signal, decoderIdentity, trustedOriginal))
          ) {
            signal.throwIfAborted();
            db.prepare('INSERT OR REPLACE INTO frame_signatures(key,data,saved) VALUES(?,?,?)').run(
              key,
              JSON.stringify(frame),
              Date.now(),
            );
            // Bounded maintenance avoids counting a growing table for each frame.
            if (++inserted % 256 === 0) {
              db.prepare(
                `DELETE FROM frame_signatures WHERE key IN (
              SELECT key FROM frame_signatures ORDER BY saved DESC, key LIMIT -1 OFFSET ?)`,
              ).run(maxEntries);
            }
          }
          return frame;
        })();
        flights.set(key, { signal, promise });
        try {
          return await promise;
        } finally {
          if (flights.get(key)?.promise === promise) flights.delete(key);
        }
      }
    },
  };
}
