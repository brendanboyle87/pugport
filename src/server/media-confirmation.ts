import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { fileIdentity, sameIno } from './platform/file-identity.ts';

// Legacy numeric stamps remain compatible; new stamps preserve exact decimal file IDs.
export type MediaFileStamp = { size: number; mtimeMs: number; ctimeMs: number; ino: string | number };
export type FullImageDuplicateConfirmation = {
  verified: boolean;
  method?: 'identical-image-pixels' | 'identical-file-bytes';
  stamps: [MediaFileStamp, MediaFileStamp];
  reason?: string;
  width?: number;
  height?: number;
  /** A direction is covered only when its EXIF/IPTC/XMP buffers are absent or identical in the other file. */
  metadataCovered?: { aByB: boolean; bByA: boolean };
};
export type FullFileDuplicateConfirmation = Omit<FullImageDuplicateConfirmation, 'method' | 'width' | 'height'> & {
  method?: 'identical-file-bytes';
};
export type FullDuplicateConfirmationOptions = {
  expectedStamps?: readonly [MediaFileStamp, MediaFileStamp];
  signal?: AbortSignal;
};
type Snapshot = { stamp: MediaFileStamp; dev: bigint; ino: bigint };
const maxEncodedBytes = 200 * 1024 * 1024;
const maxPixels = 40_000_000;
// ICC transforms can quantise distinct 8-bit values to the same value. Require matching profiles below,
// then preserve the underlying byte-valued pixels instead of allowing a lossy colour conversion to decide.
const inputOptions = { limitInputPixels: maxPixels, failOn: 'error' as const, sequentialRead: true, ignoreIcc: true };

function samePath(a: string, b: string) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function inside(path: string, root: string) {
  const tail = relative(root, path);
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
}
function stamp(info: Omit<MediaFileStamp, 'ino'>, identity: { ino: bigint }): MediaFileStamp {
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: String(identity.ino) };
}
function sameStamp(a: MediaFileStamp, b: MediaFileStamp) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && sameIno(a.ino, b.ino);
}
async function snapshot(
  path: string,
  roots: readonly string[],
  encodedLimit: number | null = maxEncodedBytes,
): Promise<Snapshot> {
  if (!roots.some((root) => inside(path, root))) throw new Error('Image confirmation is outside the explicit scope.');
  const info = await lstat(path);
  const identity = fileIdentity(await lstat(path, { bigint: true }));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular files can be confirmed.');
  const actual = await realpath(path);
  if (!samePath(actual, path) || !roots.some((root) => inside(actual, root)))
    throw new Error('Image confirmation refuses symlinks, junctions and path aliases.');
  if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('File size cannot be read safely.');
  if (encodedLimit !== null && (info.size < 1 || info.size > encodedLimit))
    throw new Error('Image confirmation requires a nonempty encoded file of at most 200 MiB.');
  return { stamp: stamp(info, identity), ...identity };
}
async function preparePair(
  a: string,
  b: string,
  roots: readonly string[],
  options: FullDuplicateConfirmationOptions,
  encodedLimit: number | null = maxEncodedBytes,
) {
  options.signal?.throwIfAborted();
  if (!isAbsolute(a) || !isAbsolute(b) || !roots.length || roots.some((root) => !isAbsolute(root)))
    throw new Error('Confirmation requires absolute file paths and explicit folder roots.');
  const paths = [resolve(a), resolve(b)] as const;
  if (samePath(paths[0], paths[1])) throw new Error('The retained copy must be a different file.');
  const allowed: string[] = [];
  for (const root of roots) {
    const normalized = resolve(root),
      actual = await realpath(normalized),
      info = await lstat(normalized);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(actual, normalized))
      throw new Error('Confirmation roots must be regular directories without junction aliases.');
    allowed.push(normalized);
  }
  const beforeA = await snapshot(paths[0], allowed, encodedLimit),
    beforeB = await snapshot(paths[1], allowed, encodedLimit);
  if (beforeA.dev === beforeB.dev && beforeA.ino !== 0n && beforeA.ino === beforeB.ino)
    throw new Error('The two paths refer to the same file; they are not independent copies.');
  if (
    options.expectedStamps &&
    (!sameStamp(options.expectedStamps[0], beforeA.stamp) || !sameStamp(options.expectedStamps[1], beforeB.stamp))
  )
    throw new Error('File changed since the candidate evidence was recorded.');
  const stamps: [MediaFileStamp, MediaFileStamp] = [beforeA.stamp, beforeB.stamp];
  const fresh = async () => {
    options.signal?.throwIfAborted();
    const currentA = await snapshot(paths[0], allowed, encodedLimit),
      currentB = await snapshot(paths[1], allowed, encodedLimit);
    if (
      currentA.dev !== beforeA.dev ||
      currentB.dev !== beforeB.dev ||
      currentA.ino !== beforeA.ino ||
      currentB.ino !== beforeB.ino ||
      !sameStamp(stamps[0], currentA.stamp) ||
      !sameStamp(stamps[1], currentB.stamp)
    )
      throw new Error('File changed while its complete content was being compared.');
  };
  return { paths, allowed, beforeA, beforeB, stamps, fresh };
}

/** Read a fixed-size full payload from the same inode, refusing growth/truncation instead of unbounded readFile. */
async function payload(path: string, before: Snapshot, roots: readonly string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const file = await open(path, flags);
  try {
    const opened = await file.stat();
    const openedIdentity = fileIdentity(await file.stat({ bigint: true }));
    if (
      !opened.isFile() ||
      openedIdentity.dev !== before.dev ||
      openedIdentity.ino !== before.ino ||
      !sameStamp(before.stamp, stamp(opened, openedIdentity))
    )
      throw new Error('Image changed before its payload could be read.');
    const bytes = Buffer.allocUnsafe(before.stamp.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const read = await file.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!read.bytesRead) throw new Error('Image was truncated during confirmation.');
      offset += read.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
    const after = await file.stat();
    const afterIdentity = fileIdentity(await file.stat({ bigint: true }));
    if (
      extra.bytesRead ||
      afterIdentity.dev !== before.dev ||
      afterIdentity.ino !== before.ino ||
      !sameStamp(before.stamp, stamp(after, afterIdentity))
    )
      throw new Error('Image changed during confirmation.');
    const current = await snapshot(path, roots);
    if (current.dev !== before.dev || current.ino !== before.ino || !sameStamp(before.stamp, current.stamp))
      throw new Error('Image path changed during confirmation.');
    signal?.throwIfAborted();
    return bytes;
  } finally {
    await file.close();
  }
}

/** PNG's decoder may expose only APNG's first frame, so inspect animation container flags as well as metadata. */
function animatedContainer(bytes: Buffer, format: Metadata['format']): boolean {
  if (format === 'png') {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (offset + length + 12 > bytes.length) throw new Error('Invalid PNG chunk length.');
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') return true;
      offset += length + 12;
      if (kind === 'IEND') break;
    }
  } else if (format === 'webp') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32LE(offset + 4);
      if (offset + length + 8 > bytes.length) throw new Error('Invalid WebP chunk length.');
      const kind = bytes.toString('ascii', offset, offset + 4);
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && length > 0 && bytes[offset + 8]! & 2)) return true;
      offset += length + 8 + (length % 2);
    }
  } else if (format === 'jpeg') {
    // MPO stores additional JPEG pictures behind an APP2 MPF index that a normal decoder may ignore.
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw new Error('Invalid JPEG segment length.');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG segment length.');
      if (marker === 0xe2 && length >= 6 && bytes.toString('ascii', offset + 2, offset + 6) === 'MPF\0') return true;
      offset += length;
    }
  }
  return false;
}
async function metadata(bytes: Buffer) {
  const info = await sharp(bytes, inputOptions).metadata();
  if (!['jpeg', 'png', 'webp'].includes(info.format))
    throw new Error('Full-image confirmation supports only JPEG, PNG and WebP.');
  if (
    (info.pages ?? 1) !== 1 ||
    info.loop !== undefined ||
    !!info.delay?.length ||
    animatedContainer(bytes, info.format)
  )
    throw new Error('Animated or multipage images require separate verification; the first frame is insufficient.');
  if (info.depth !== 'uchar' || (info.bitsPerSample ?? 8) > 8 || info.gainMap)
    throw new Error('Full-image confirmation refuses high-bit-depth and HDR images.');
  if (!['srgb', 'b-w'].includes(info.space))
    throw new Error('Full-image confirmation refuses colour spaces that require a lossy conversion.');
  if (!info.width || !info.height || info.width * info.height > maxPixels)
    throw new Error('Image confirmation exceeds the 40-megapixel limit.');
  return info;
}
async function rgba(bytes: Buffer) {
  const decoded = await sharp(bytes, inputOptions)
    .autoOrient()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.channels !== 4 ||
    decoded.info.width * decoded.info.height > maxPixels ||
    decoded.data.length !== decoded.info.width * decoded.info.height * 4
  )
    throw new Error('Image confirmation did not decode one complete, full-resolution RGBA image.');
  return decoded;
}
function metadataCovered(a: Metadata, b: Metadata) {
  const covered = (source: Metadata, target: Metadata) =>
    (['exif', 'iptc', 'xmp'] as const).every(
      (key) => !source[key] || (!!target[key] && source[key]!.equals(target[key]!)),
    );
  return { aByB: covered(a, b), bByA: covered(b, a) };
}

/**
 * Read-only confirmation of a single candidate pair. Perceptual hashes, resizing and sparse feature matches
 * never decide this result. Callers must use one worker and separately revalidate stamps before any recycle.
 */
export async function verifyFullImageDuplicate(
  a: string,
  b: string,
  roots: readonly string[],
  options: FullDuplicateConfirmationOptions = {},
): Promise<FullImageDuplicateConfirmation> {
  const { signal } = options;
  const { paths, allowed, beforeA, beforeB, stamps, fresh } = await preparePair(a, b, roots, options);
  let bytesA: Buffer | undefined = await payload(paths[0], beforeA, allowed, signal);
  const metaA = await metadata(bytesA);
  let bytesB: Buffer | undefined = await payload(paths[1], beforeB, allowed, signal);
  const metaB = await metadata(bytesB);
  if (bytesA.equals(bytesB)) {
    await fresh();
    return {
      verified: true,
      method: 'identical-file-bytes',
      stamps,
      width: metaA.autoOrient.width,
      height: metaA.autoOrient.height,
      metadataCovered: { aByB: true, bByA: true },
    };
  }
  if (!!metaA.icc !== !!metaB.icc || (metaA.icc && metaB.icc && !metaA.icc.equals(metaB.icc)))
    throw new Error('Images have different colour profiles; pixel-only confirmation is insufficient.');
  // Compare oriented dimensions before allocating full RGBA buffers. No image is ever resized.
  if (metaA.autoOrient.width !== metaB.autoOrient.width || metaA.autoOrient.height !== metaB.autoOrient.height) {
    await fresh();
    return { verified: false, stamps, reason: 'Full-resolution image dimensions differ.' };
  }
  signal?.throwIfAborted();
  const decodedA = await rgba(bytesA);
  bytesA = undefined;
  signal?.throwIfAborted();
  const decodedB = await rgba(bytesB);
  bytesB = undefined;
  await fresh();
  if (
    decodedA.info.width !== decodedB.info.width ||
    decodedA.info.height !== decodedB.info.height ||
    !decodedA.data.equals(decodedB.data)
  )
    return { verified: false, stamps, reason: 'Complete image pixels differ; similarity alone is insufficient.' };
  return {
    verified: true,
    method: 'identical-image-pixels',
    stamps,
    width: decodedA.info.width,
    height: decodedA.info.height,
    metadataCovered: metadataCovered(metaA, metaB),
  };
}

/** Full byte-for-byte confirmation for any regular file, with fixed memory independent of its size. */
export async function verifyFullFileDuplicate(
  a: string,
  b: string,
  roots: readonly string[],
  options: FullDuplicateConfirmationOptions = {},
): Promise<FullFileDuplicateConfirmation> {
  const { signal } = options;
  const { paths, beforeA, beforeB, stamps, fresh } = await preparePair(a, b, roots, options, null);
  if (beforeA.stamp.size !== beforeB.stamp.size) {
    await fresh();
    return { verified: false, stamps, reason: 'Complete file sizes differ.' };
  }
  signal?.throwIfAborted();
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const fileA = await open(paths[0], flags);
  let fileB: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fileB = await open(paths[1], flags);
    const openedA = await fileA.stat(),
      openedB = await fileB.stat();
    const openedIdentityA = fileIdentity(await fileA.stat({ bigint: true })),
      openedIdentityB = fileIdentity(await fileB.stat({ bigint: true }));
    if (
      !openedA.isFile() ||
      !openedB.isFile() ||
      openedIdentityA.dev !== beforeA.dev ||
      openedIdentityB.dev !== beforeB.dev ||
      openedIdentityA.ino !== beforeA.ino ||
      openedIdentityB.ino !== beforeB.ino ||
      !sameStamp(stamps[0], stamp(openedA, openedIdentityA)) ||
      !sameStamp(stamps[1], stamp(openedB, openedIdentityB))
    )
      throw new Error('File changed before its complete content could be read.');
    const blockSize = 1024 * 1024,
      bytesA = Buffer.allocUnsafe(blockSize),
      bytesB = Buffer.allocUnsafe(blockSize);
    const readBlock = async (file: typeof fileA, bytes: Buffer, offset: number, length: number) => {
      let done = 0;
      while (done < length) {
        signal?.throwIfAborted();
        const read = await file.read(bytes, done, length - done, offset + done);
        if (!read.bytesRead) throw new Error('File was truncated during complete-content confirmation.');
        done += read.bytesRead;
      }
    };
    let identical = true,
      offset = 0;
    while (offset < beforeA.stamp.size) {
      const length = Math.min(blockSize, beforeA.stamp.size - offset);
      await readBlock(fileA, bytesA, offset, length);
      await readBlock(fileB, bytesB, offset, length);
      if (!bytesA.subarray(0, length).equals(bytesB.subarray(0, length))) {
        identical = false;
        break;
      }
      offset += length;
    }
    // A successful proof must reach both EOFs. A mismatch needs no further reads, but still checks freshness.
    if (identical) {
      signal?.throwIfAborted();
      const extraA = await fileA.read(bytesA, 0, 1, beforeA.stamp.size),
        extraB = await fileB.read(bytesB, 0, 1, beforeB.stamp.size);
      if (extraA.bytesRead || extraB.bytesRead) throw new Error('File grew during complete-content confirmation.');
    }
    const afterA = await fileA.stat(),
      afterB = await fileB.stat();
    const afterIdentityA = fileIdentity(await fileA.stat({ bigint: true })),
      afterIdentityB = fileIdentity(await fileB.stat({ bigint: true }));
    if (
      afterIdentityA.dev !== beforeA.dev ||
      afterIdentityB.dev !== beforeB.dev ||
      afterIdentityA.ino !== beforeA.ino ||
      afterIdentityB.ino !== beforeB.ino ||
      !sameStamp(stamps[0], stamp(afterA, afterIdentityA)) ||
      !sameStamp(stamps[1], stamp(afterB, afterIdentityB))
    )
      throw new Error('File changed during complete-content confirmation.');
    await fresh();
    return identical
      ? { verified: true, method: 'identical-file-bytes', stamps, metadataCovered: { aByB: true, bByA: true } }
      : { verified: false, stamps, reason: 'Complete file bytes differ.' };
  } finally {
    try {
      await fileB?.close();
    } finally {
      await fileA.close();
    }
  }
}
