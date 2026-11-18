import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import {
  verifyFullFileDuplicate,
  verifyFullImageDuplicate,
  type MediaFileStamp,
} from '../src/server/media-confirmation.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-confirmation-')));
  const media = join(root, 'media');
  await mkdir(media);
  return {
    root,
    media,
    a: join(media, 'a.png'),
    b: join(media, 'b.png'),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
async function stamp(path: string): Promise<MediaFileStamp> {
  const info = await lstat(path);
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: String((await lstat(path, { bigint: true })).ino),
  };
}
function picture(width = 16, height = 12) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = (index * 13) % 256;
    data[index * 4 + 1] = (index * 31) % 256;
    data[index * 4 + 2] = (index * 7) % 256;
    data[index * 4 + 3] = 255;
  }
  return sharp(data, { raw: { width, height, channels: 4 } });
}
function pngChunk(kind: string, data: Buffer) {
  const name = Buffer.from(kind);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

for (const verify of [verifyFullImageDuplicate, verifyFullFileDuplicate]) {
  test(`${verify.name} distinguishes file IDs that collide as Numbers`, async (t) => {
    const f = await fixture();
    const originalLstat = fs.lstat;
    const originalOpen = fs.open;
    const ids = new Map([
      [f.a, 2n ** 54n],
      [f.b, 2n ** 54n + 1n],
    ]);
    assert.equal(Number(ids.get(f.a)), Number(ids.get(f.b)));
    const withId = <T extends { ino: number | bigint }>(info: T, path: unknown): T => {
      const id = ids.get(String(path));
      if (id !== undefined) info.ino = typeof info.ino === 'bigint' ? id : Number(id);
      return info;
    };
    try {
      await picture().png().toFile(f.a);
      await copyFile(f.a, f.b);
      t.mock.method(fs, 'lstat', (async (...args: Parameters<typeof fs.lstat>) =>
        withId(await originalLstat(...args), args[0])) as typeof fs.lstat);
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const file = await originalOpen(...args);
        const originalStat = file.stat.bind(file);
        t.mock.method(file, 'stat', (async (...options: Parameters<typeof file.stat>) =>
          withId(await originalStat(...options), args[0])) as typeof file.stat);
        return file;
      });
      syncBuiltinESMExports();
      const expected = [await stamp(f.a), await stamp(f.b)] as const;
      const report = await verify(f.a, f.b, [f.media], { expectedStamps: expected });
      assert.equal(report.verified, true);
      assert.equal(report.method, 'identical-file-bytes');
      assert.deepEqual(report.stamps, expected);
      assert.doesNotThrow(() => JSON.stringify(report));
      assert.equal(report.stamps[0].ino, String(ids.get(f.a)));
      const legacy = expected.map((value) => ({ ...value, ino: Number(value.ino) })) as [
        MediaFileStamp,
        MediaFileStamp,
      ];
      assert.equal((await verify(f.a, f.b, [f.media], { expectedStamps: legacy })).verified, true);
      ids.set(f.b, ids.get(f.a)!);
      await assert.rejects(verify(f.a, f.b, [f.media]), /same file/);
      ids.set(f.b, 2n ** 54n + 1n);
      let checks = 0;
      const signal = new AbortController().signal;
      Object.defineProperty(signal, 'throwIfAborted', {
        value: () => {
          if (++checks === 2) ids.set(f.a, 2n ** 54n + 2n);
        },
      });
      await assert.rejects(verify(f.a, f.b, [f.media], { signal }), /changed before/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await f.close();
    }
  });
}

test('complete encoded-byte duplicates are preferred and return fresh stamps without changing either source', async () => {
  const f = await fixture();
  try {
    await picture().png().toFile(f.a);
    await copyFile(f.a, f.b);
    const expected = [await stamp(f.a), await stamp(f.b)] as const;
    const before = [await readFile(f.a), await readFile(f.b)];
    const report = await verifyFullImageDuplicate(f.a, f.b, [f.media], { expectedStamps: expected });
    assert.equal(report.verified, true);
    assert.equal(report.method, 'identical-file-bytes');
    assert.deepEqual(report.stamps, expected);
    assert.deepEqual(report.metadataCovered, { aByB: true, bByA: true });
    assert.deepEqual([report.width, report.height], [16, 12]);
    assert.deepEqual([await readFile(f.a), await readFile(f.b)], before);
    assert.deepEqual([await stamp(f.a), await stamp(f.b)], expected);
  } finally {
    await f.close();
  }
});

test('different lossless containers with identical full pixels pass and preserve the richer EXIF direction', async () => {
  const f = await fixture();
  try {
    await picture().png({ compressionLevel: 0 }).toFile(f.a);
    await picture()
      .withExif({ IFD0: { Artist: 'synthetic fixture author' } })
      .png({ compressionLevel: 9 })
      .toFile(f.b);
    assert.equal((await readFile(f.a)).equals(await readFile(f.b)), false);
    const report = await verifyFullImageDuplicate(f.a, f.b, [f.media]);
    assert.equal(report.verified, true);
    assert.equal(report.method, 'identical-image-pixels');
    assert.deepEqual(report.metadataCovered, { aByB: true, bByA: false });
    assert.deepEqual([report.width, report.height], [16, 12]);
  } finally {
    await f.close();
  }
});

test('conflicting EXIF remains uncovered even when all image pixels are identical', async () => {
  const f = await fixture();
  try {
    await picture()
      .withExif({ IFD0: { Artist: 'author one' } })
      .png()
      .toFile(f.a);
    await picture()
      .withExif({ IFD0: { Artist: 'author two' } })
      .png()
      .toFile(f.b);
    const report = await verifyFullImageDuplicate(f.a, f.b, [f.media]);
    assert.equal(report.verified, true, 'the result proves pixels only');
    assert.deepEqual(report.metadataCovered, { aByB: false, bByA: false }, 'neither source metadata can be discarded');
  } finally {
    await f.close();
  }
});

test('one byte-valued pixel difference rejects a pair even when its thumbnail perceptual hash is unchanged', async () => {
  const f = await fixture();
  try {
    const pixels = Buffer.alloc(64 * 64 * 3, 80),
      different = Buffer.from(pixels);
    different[0] = 81;
    await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
      .png()
      .toFile(f.a);
    await sharp(different, { raw: { width: 64, height: 64, channels: 3 } })
      .png()
      .toFile(f.b);
    // Identical 9x8 grayscale thumbnails imply an identical difference hash, yet the original byte differs.
    const thumbnail = (path: string) => sharp(path).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
    assert.deepEqual(await thumbnail(f.a), await thumbnail(f.b));
    const report = await verifyFullImageDuplicate(f.a, f.b, [f.media]);
    assert.equal(report.verified, false);
    assert.equal(report.method, undefined);
    assert.match(report.reason!, /pixels differ/);
  } finally {
    await f.close();
  }
});

test('different dimensions and different alpha bytes never qualify through resizing or visual similarity', async () => {
  const f = await fixture();
  try {
    await picture().png().toFile(f.a);
    await picture().resize(8, 6).png().toFile(f.b);
    assert.match((await verifyFullImageDuplicate(f.a, f.b, [f.media])).reason!, /dimensions differ/);
    const rgba = Buffer.alloc(4 * 4 * 4, 0),
      other = Buffer.from(rgba);
    other[0] = 1; // Hidden RGB under zero alpha is still part of the full pixel payload.
    await sharp(rgba, { raw: { width: 4, height: 4, channels: 4 } })
      .png()
      .toFile(f.a);
    await sharp(other, { raw: { width: 4, height: 4, channels: 4 } })
      .png()
      .toFile(f.b);
    assert.equal((await verifyFullImageDuplicate(f.a, f.b, [f.media])).verified, false);
  } finally {
    await f.close();
  }
});

test('EXIF orientation is applied at full resolution but its differing metadata is not declared covered', async () => {
  const f = await fixture();
  try {
    await picture().withMetadata({ orientation: 1 }).png().toFile(f.a);
    await picture().rotate(-90).withMetadata({ orientation: 6 }).png().toFile(f.b);
    const report = await verifyFullImageDuplicate(f.a, f.b, [f.media]);
    assert.equal(report.verified, true);
    assert.equal(report.method, 'identical-image-pixels');
    assert.deepEqual([report.width, report.height], [16, 12]);
    assert.deepEqual(report.metadataCovered, { aByB: false, bByA: false });
  } finally {
    await f.close();
  }
});

test('animation is refused before identical first frames or identical bytes could qualify', async () => {
  const f = await fixture();
  try {
    const frames = Buffer.alloc(4 * 8 * 4, 180);
    frames.fill(90, 4 * 4 * 4);
    const animated = await sharp(frames, {
      raw: { width: 4, height: 8, channels: 4, pageHeight: 4 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    await writeFile(f.a, animated);
    await copyFile(f.a, f.b);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media]), /Animated or multipage/);
    const still = await picture().png().toBuffer();
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(2, 0);
    const apng = Buffer.concat([still.subarray(0, 33), pngChunk('acTL', animationControl), still.subarray(33)]);
    await writeFile(f.a, apng);
    await copyFile(f.a, f.b);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media]), /Animated or multipage/);
  } finally {
    await f.close();
  }
});

test('high-bit-depth, non-sRGB and different ICC profiles are refused without quantising them into equal pixels', async () => {
  const f = await fixture();
  try {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 16;
    header[9] = 6; // One RGBA pixel, sixteen bits per channel.
    const png16 = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(Buffer.alloc(9, 0))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    await writeFile(f.a, png16);
    await copyFile(f.a, f.b);
    assert.equal((await sharp(png16).metadata()).bitsPerSample, 16);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media]), /high-bit-depth/);
    await picture().toColourspace('cmyk').jpeg().toFile(f.a);
    await copyFile(f.a, f.b);
    assert.equal((await sharp(f.a).metadata()).space, 'cmyk');
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media]), /colour spaces/);
    await picture().png().toFile(f.a);
    await picture().withMetadata().png().toFile(f.b);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media]), /different colour profiles/);
  } finally {
    await f.close();
  }
});

test('JPEG multipicture containers and oversized pixel headers cannot qualify through first-picture decoding', async () => {
  const f = await fixture();
  try {
    const jpeg = await picture().jpeg().toBuffer();
    const mpf = Buffer.from([0xff, 0xe2, 0, 6, 0x4d, 0x50, 0x46, 0]);
    await writeFile(f.a, Buffer.concat([jpeg.subarray(0, 2), mpf, jpeg.subarray(2)]));
    await copyFile(f.a, f.b);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media]), /Animated or multipage/);

    const png = await picture().png().toBuffer();
    const header = Buffer.from(png.subarray(16, 29));
    header.writeUInt32BE(7000, 0);
    header.writeUInt32BE(7000, 4);
    await writeFile(f.a, Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), png.subarray(33)]));
    await copyFile(f.a, f.b);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media]), /pixel limit|40-megapixel/i);
  } finally {
    await f.close();
  }
});

test('stale evidence and a file growing during its bounded payload read both reject confirmation', async () => {
  const f = await fixture();
  try {
    await picture().png().toFile(f.a);
    await copyFile(f.a, f.b);
    const expected = [await stamp(f.a), await stamp(f.b)] as const;
    await picture(17, 12).png().toFile(f.a);
    await assert.rejects(
      verifyFullImageDuplicate(f.a, f.b, [f.media], { expectedStamps: expected }),
      /candidate evidence/,
    );
    await copyFile(f.b, f.a);
    let checks = 0;
    const signal = new AbortController().signal;
    Object.defineProperty(signal, 'throwIfAborted', {
      value: () => {
        if (++checks === 3) appendFileSync(f.a, Buffer.from([1]));
      },
    });
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media], { signal }), /changed during confirmation/);
  } finally {
    await f.close();
  }
});

test('out-of-scope paths, aliases, same files and cancellation never produce confirmation', async () => {
  const f = await fixture();
  try {
    await picture().png().toFile(f.a);
    await copyFile(f.a, f.b);
    const outside = join(f.root, 'outside.png');
    await copyFile(f.a, outside);
    await assert.rejects(verifyFullImageDuplicate(f.a, outside, [f.media]), /outside the explicit scope/);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.a, [f.media]), /different file/);
    const hardlink = join(f.media, 'hardlink.png');
    await link(f.a, hardlink);
    await assert.rejects(verifyFullImageDuplicate(f.a, hardlink, [f.media]), /same file/);
    const alias = join(f.root, 'alias');
    await symlink(f.media, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(verifyFullImageDuplicate(join(alias, 'a.png'), f.b, [f.root]), /junctions and path aliases/);
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [alias]), /junction aliases/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(verifyFullImageDuplicate(f.a, f.b, [f.media], { signal: controller.signal }), /aborted/);
  } finally {
    await f.close();
  }
});

test('complete file confirmation compares multiple full blocks and a partial tail without decoding media', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 61);
    bytes[bytes.length - 1] = 214;
    await writeFile(f.a, bytes);
    await copyFile(f.a, f.b);
    const expected = [await stamp(f.a), await stamp(f.b)] as const;
    const result = await verifyFullFileDuplicate(f.a, f.b, [f.media], { expectedStamps: expected });
    assert.equal(result.verified, true);
    assert.equal(result.method, 'identical-file-bytes');
    assert.deepEqual(result.metadataCovered, { aByB: true, bByA: true });
    assert.deepEqual(result.stamps, expected);
    assert.deepEqual([await stamp(f.a), await stamp(f.b)], expected);
    assert.deepEqual(await readFile(f.a), bytes);
    assert.deepEqual(await readFile(f.b), bytes);
  } finally {
    await f.close();
  }
});

test('same-size file confirmation rejects a difference in the final byte after otherwise identical blocks', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.alloc(1024 * 1024 + 11, 91);
    await writeFile(f.a, bytes);
    bytes[bytes.length - 1] = 92;
    await writeFile(f.b, bytes);
    const result = await verifyFullFileDuplicate(f.a, f.b, [f.media]);
    assert.equal(result.verified, false);
    assert.equal(result.method, undefined);
    assert.match(result.reason!, /bytes differ/);
  } finally {
    await f.close();
  }
});

test('complete file confirmation rejects different sizes before comparing bytes', async () => {
  const f = await fixture();
  try {
    await writeFile(f.a, 'same prefix');
    await writeFile(f.b, 'same prefix with a tail');
    const result = await verifyFullFileDuplicate(f.a, f.b, [f.media]);
    assert.equal(result.verified, false);
    assert.equal(result.method, undefined);
    assert.match(result.reason!, /sizes differ/);
  } finally {
    await f.close();
  }
});

test('complete file confirmation rejects stale evidence and growth while its original blocks are being read', async () => {
  const f = await fixture();
  try {
    await writeFile(f.a, 'identical content');
    await copyFile(f.a, f.b);
    const expected = [await stamp(f.a), await stamp(f.b)] as const;
    appendFileSync(f.a, '!');
    await assert.rejects(
      verifyFullFileDuplicate(f.a, f.b, [f.media], { expectedStamps: expected }),
      /candidate evidence/,
    );
    await copyFile(f.b, f.a);
    let checks = 0;
    const signal = new AbortController().signal;
    Object.defineProperty(signal, 'throwIfAborted', {
      value: () => {
        if (++checks === 3) appendFileSync(f.b, '!');
      },
    });
    await assert.rejects(verifyFullFileDuplicate(f.a, f.b, [f.media], { signal }), /grew during/);
  } finally {
    await f.close();
  }
});

test('complete file confirmation stops during streaming and shares strict scope and independent-copy checks', async () => {
  const f = await fixture();
  try {
    await writeFile(f.a, Buffer.alloc(1024 * 1024 + 11, 77));
    await copyFile(f.a, f.b);
    const controller = new AbortController();
    const throwIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    Object.defineProperty(controller.signal, 'throwIfAborted', {
      value: () => {
        if (++checks === 3) controller.abort();
        throwIfAborted();
      },
    });
    await assert.rejects(verifyFullFileDuplicate(f.a, f.b, [f.media], { signal: controller.signal }), /aborted/);
    const outside = join(f.root, 'outside-video.mkv');
    await copyFile(f.a, outside);
    await assert.rejects(verifyFullFileDuplicate(f.a, outside, [f.media]), /outside the explicit scope/);
    const hardlink = join(f.media, 'same-inode.mkv');
    await link(f.a, hardlink);
    await assert.rejects(verifyFullFileDuplicate(f.a, hardlink, [f.media]), /same file/);
  } finally {
    await f.close();
  }
});
