import { largeFileId, mockFileIds } from './helpers/file-identity.ts';
import { useMediaFixture } from './helpers/tool-fixtures.ts';
import { after as afterTools } from 'node:test';
const cleanTools = useMediaFixture();
afterTools(cleanTools);
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, copyFile, lstat, mkdtemp, readFile, realpath, rm, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findMediaExecutables } from '../src/server/media-decoder.ts';
import { confirmCompressedVideoDuplicate } from '../src/server/media-packet-confirmation.ts';
import type { MediaFileStamp } from '../src/server/media-confirmation.ts';

const binaries = findMediaExecutables(process.cwd());
const execute = promisify(execFile);
const enabled = !!binaries.ffmpeg && !!binaries.ffprobe;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-packet-synthetic-')));
  const generate = async (name: string, args: string[]) => {
    const path = join(root, name);
    await execute(
      binaries.ffmpeg!,
      ['-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-y', ...args, path],
      { windowsHide: true, timeout: 30000 },
    );
    return path;
  };
  return { root, generate, close: () => rm(root, { recursive: true, force: true }) };
}
const video = ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10:duration=3'];
const encoded = ['-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p'];

test('packet identity guards and stored stamps retain high file-ID bits', { skip: !enabled }, async (t) => {
  const f = await fixture();
  t.after(f.close);
  const a = await f.generate('id-a.mp4', [...video, ...encoded]),
    b = join(f.root, 'id-b.mp4');
  await copyFile(a, b);
  const ids = mockFileIds(t, [
    [a, largeFileId],
    [b, largeFileId + 1n],
  ]);
  const expected = [await stamp(a), await stamp(b)] as const;
  const report = await confirmCompressedVideoDuplicate(a, b, [f.root], { expectedStamps: expected });
  assert.equal(report.verified, true, report.reason ?? '');
  assert.equal(report.stamps[0].ino, String(largeFileId));
  assert.doesNotThrow(() => JSON.stringify(report));
  const legacy = expected.map((value) => ({ ...value, ino: Number(value.ino) })) as [MediaFileStamp, MediaFileStamp];
  assert.equal((await confirmCompressedVideoDuplicate(a, b, [f.root], { expectedStamps: legacy })).verified, true);
  ids.set(a, largeFileId + 1n);
  assert.match((await confirmCompressedVideoDuplicate(a, b, [f.root])).reason!, /same file identity/);
  ids.set(a, largeFileId + 2n);
  assert.match(
    (await confirmCompressedVideoDuplicate(a, b, [f.root], { expectedStamps: expected })).reason!,
    /changed since/,
  );
  ids.set(a, largeFileId);
  const changed = await confirmCompressedVideoDuplicate(a, b, [f.root], {
    onProgress: () => {
      ids.set(a, largeFileId + 2n);
    },
  });
  assert.equal(changed.verified, false);
  assert.match(changed.reason!, /changed/);
});
async function stamp(path: string) {
  const info = await lstat(path);
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: String((await lstat(path, { bigint: true })).ino),
  };
}

test(
  'only mapped movie/media header creation dates normalize, with original dates recorded',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const a = await f.generate('dated.mp4', [
        ...video,
        ...encoded,
        '-metadata',
        'creation_time=2020-01-02T03:04:05Z',
      ]);
      const b = await f.generate('dated-remux.mp4', ['-i', a, '-map', '0', '-c', 'copy']);
      const bytes = await readFile(a),
        changed = await readFile(b);
      const seconds = Math.floor(Date.parse('2021-02-03T04:05:06Z') / 1000) + 2082844800;
      for (const type of ['mvhd', 'tkhd', 'mdhd']) {
        const p = changed.indexOf(Buffer.from(type));
        assert.ok(p >= 0);
        assert.equal(changed[p + 4], 0);
        changed.writeUInt32BE(seconds, p + 8);
        changed.writeUInt32BE(seconds + 1, p + 12);
      }
      await writeFile(b, changed);
      const defaultProof = await confirmCompressedVideoDuplicate(a, b, [f.root]);
      assert.equal(defaultProof.recycleEligible, false);
      assert.match(defaultProof.reason!, /explicit durable/);
      const archive = { headerDatePolicy: 'archive-original-dates-in-proof' } as const;
      const proof = await confirmCompressedVideoDuplicate(a, b, [f.root], archive);
      assert.equal(proof.recycleEligible, true, proof.reason ?? '');
      assert.equal(proof.auxiliary.headerDateNormalization?.policy, archive.headerDatePolicy);
      assert.equal(proof.auxiliary.headerDateNormalization?.requiresDurableArchive, true);
      assert.equal(
        proof.auxiliary.headerDateNormalization?.originalDates.candidate.formatCreationTime,
        '2020-01-02T03:04:05.000000Z',
      );
      assert.equal(
        proof.auxiliary.headerDateNormalization?.originalDates.retained.formatCreationTime,
        '2021-02-03T04:05:06.000000Z',
      );
      assert.equal(
        proof.auxiliary.headerDateNormalization?.originalDates.retained.streamCreationTimes[0],
        '2021-02-03T04:05:06.000000Z',
      );
      assert.ok(
        proof.auxiliary.headerDateNormalization!.originalDates.retained.headers.every(
          (header) =>
            header.rawCreationSeconds === String(seconds) && header.rawModificationSeconds === String(seconds + 1),
        ),
      );
      const hidden = Buffer.from(bytes),
        track = hidden.indexOf(Buffer.from('tkhd'));
      hidden.writeUInt32BE(hidden.readUInt32BE(track + 8) + 10, track + 8);
      hidden.writeUInt32BE(hidden.readUInt32BE(track + 12) + 11, track + 12);
      const hiddenPath = join(f.root, 'hidden-track-dates.mp4');
      await writeFile(hiddenPath, hidden);
      assert.equal((await confirmCompressedVideoDuplicate(a, hiddenPath, [f.root])).recycleEligible, false);
      const hiddenArchived = await confirmCompressedVideoDuplicate(a, hiddenPath, [f.root], archive);
      assert.equal(hiddenArchived.recycleEligible, true, hiddenArchived.reason ?? '');
      assert.equal(
        hiddenArchived.auxiliary.headerDateNormalization!.originalDates.candidate.formatCreationTime,
        hiddenArchived.auxiliary.headerDateNormalization!.originalDates.retained.formatCreationTime,
      );
      assert.deepEqual(
        hiddenArchived.auxiliary.headerDateNormalization!.originalDates.candidate.streamCreationTimes,
        hiddenArchived.auxiliary.headerDateNormalization!.originalDates.retained.streamCreationTimes,
      );
      const cleared = Buffer.from(bytes);
      for (const type of ['mvhd', 'tkhd', 'mdhd']) {
        const p = cleared.indexOf(Buffer.from(type));
        cleared.fill(0, p + 8, p + 16);
      }
      const noDate = join(f.root, 'zero-header-dates.mp4');
      await writeFile(noDate, cleared);
      assert.equal((await confirmCompressedVideoDuplicate(a, noDate, [f.root])).recycleEligible, false);
      const clearedProof = await confirmCompressedVideoDuplicate(a, noDate, [f.root], archive);
      assert.equal(clearedProof.recycleEligible, true, clearedProof.reason ?? '');
      assert.equal(clearedProof.auxiliary.headerDateNormalization?.originalDates.retained.formatCreationTime, null);
      const altered = Buffer.from(changed),
        movie = altered.indexOf(Buffer.from('mvhd'));
      altered.writeUInt32BE(0x00020000, movie + 24); // Change movie rate, not a date.
      const nonDate = join(f.root, 'non-date.mp4');
      await writeFile(nonDate, altered);
      assert.equal((await confirmCompressedVideoDuplicate(a, nonDate, [f.root], archive)).recycleEligible, false);
      const ambiguous = Buffer.from(changed);
      for (const type of ['mvhd', 'tkhd', 'mdhd']) {
        const p = ambiguous.indexOf(Buffer.from(type));
        ambiguous.writeUInt32BE(123, p + 8);
      }
      const old = join(f.root, 'ambiguous-epoch.mp4');
      await writeFile(old, ambiguous);
      assert.equal((await confirmCompressedVideoDuplicate(a, old, [f.root], archive)).recycleEligible, false);

      for (const tag of ['creation_time', 'capture_date', 'exif_date']) {
        const x = await f.generate(`authored-${tag}-a.mp4`, [
          '-i',
          a,
          '-c',
          'copy',
          '-movflags',
          'use_metadata_tags',
          '-metadata',
          `${tag}=2022-03-04T05:06:07Z`,
        ]);
        const y = await f.generate(`authored-${tag}-b.mp4`, [
          '-i',
          a,
          '-c',
          'copy',
          '-movflags',
          'use_metadata_tags',
          '-metadata',
          `${tag}=2023-04-05T06:07:08Z`,
        ]);
        assert.equal((await confirmCompressedVideoDuplicate(x, y, [f.root], archive)).recycleEligible, false, tag);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'only one retained-only bounded terminal top-level zero padding suffix may be added',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const base = await f.generate('base.mp4', [...video, ...encoded]);
      const source = await readFile(base);
      const zeroBox = Buffer.alloc(10);
      zeroBox.writeUInt32BE(10);
      const put = async (name: string, bytes: Buffer) => {
        const path = join(f.root, name);
        await writeFile(path, bytes);
        return path;
      };
      const retained = await put('terminal-padding.mp4', Buffer.concat([source, zeroBox]));
      const positive = await confirmCompressedVideoDuplicate(base, retained, [f.root]);
      assert.equal(positive.recycleEligible, true, positive.reason ?? '');
      assert.deepEqual(positive.auxiliary.retainedOnlyTerminalZeroPadding, { bytes: 10, header: 'explicit-size32' });
      assert.equal(positive.metadataCovered, true);
      assert.equal((await confirmCompressedVideoDuplicate(retained, base, [f.root])).recycleEligible, false);
      const equalPadding = join(f.root, 'equal-padding.mp4');
      await copyFile(retained, equalPadding);
      const equal = await confirmCompressedVideoDuplicate(retained, equalPadding, [f.root]);
      assert.equal(equal.recycleEligible, true, equal.reason ?? '');
      assert.equal(equal.auxiliary.retainedOnlyTerminalZeroPadding, undefined);

      const payload = Buffer.from(zeroBox);
      payload[9] = 1;
      const typed = Buffer.from(zeroBox);
      typed.write('zzzz', 4);
      const oversized = Buffer.alloc(4097);
      oversized.writeUInt32BE(4097);
      const implicit = Buffer.from(zeroBox);
      implicit.writeUInt32BE(0);
      const implicitPath = await put('all-zero-eof.mp4', Buffer.concat([source, implicit]));
      const implicitPositive = await confirmCompressedVideoDuplicate(base, implicitPath, [f.root]);
      assert.equal(implicitPositive.recycleEligible, true, implicitPositive.reason ?? '');
      assert.deepEqual(implicitPositive.auxiliary.retainedOnlyTerminalZeroPadding, {
        bytes: 10,
        header: 'all-zero-eof',
        candidatePrefixBytesVerified: source.length,
        candidatePrefixSha256: (await import('node:crypto')).createHash('sha256').update(source).digest('hex'),
      });
      assert.equal((await confirmCompressedVideoDuplicate(implicitPath, base, [f.root])).recycleEligible, false);
      const implicitPayload = Buffer.from(implicit);
      implicitPayload[9] = 1;
      const implicitType = Buffer.from(implicit);
      implicitType.write('zzzz', 4);
      const freeA = Buffer.alloc(12);
      freeA.writeUInt32BE(12);
      freeA.write('free', 4);
      const freeB = Buffer.from(freeA);
      freeB[11] = 1;
      const candidateFree = await put('candidate-free.mp4', Buffer.concat([source, freeA]));
      const retainedDifferentPrefix = await put(
        'retained-different-prefix.mp4',
        Buffer.concat([source, freeB, implicit]),
      );
      const differentPrefix = await confirmCompressedVideoDuplicate(candidateFree, retainedDifferentPrefix, [f.root]);
      assert.equal(differentPrefix.verified, true, differentPrefix.reason ?? '');
      assert.equal(differentPrefix.recycleEligible, false);
      assert.match(differentPrefix.reason!, /every candidate encoded byte/);
      const malformed = Buffer.from(zeroBox);
      malformed.writeUInt32BE(9);
      const extended = Buffer.alloc(18);
      extended.writeUInt32BE(1);
      extended.writeBigUInt64BE(18n, 8);
      for (const [name, suffix] of [
        ['nonzero', payload],
        ['typed', typed],
        ['oversized', oversized],
        ['implicit-payload', implicitPayload],
        ['implicit-type', implicitType],
        ['implicit-oversized', Buffer.alloc(4097)],
        ['implicit-nonterminal', Buffer.concat([implicit, typed])],
        ['malformed', malformed],
        ['extended', extended],
        ['two', Buffer.concat([zeroBox, zeroBox])],
        ['nonterminal', Buffer.concat([zeroBox, typed])],
      ] as const) {
        const path = await put(`${name}.mp4`, Buffer.concat([source, suffix]));
        const proof = await confirmCompressedVideoDuplicate(base, path, [f.root]);
        assert.equal(proof.recycleEligible, false, `${name}: ${proof.reason}`);
        assert.equal(proof.auxiliary.retainedOnlyTerminalZeroPadding, undefined);
      }
      const unique = await put('candidate-unique.mp4', Buffer.concat([source, payload]));
      assert.equal((await confirmCompressedVideoDuplicate(unique, retained, [f.root])).recycleEligible, false);

      let movie = -1,
        track = -1;
      for (let p = 0; p < source.length;) {
        const n = source.readUInt32BE(p);
        if (source.toString('latin1', p + 4, p + 8) === 'moov') {
          movie = p;
          break;
        }
        p += n;
      }
      for (let p = movie + 8; p < movie + source.readUInt32BE(movie);) {
        const n = source.readUInt32BE(p);
        if (source.toString('latin1', p + 4, p + 8) === 'trak') {
          track = p;
          break;
        }
        p += n;
      }
      assert.ok(track >= 0);
      const trackSize = source.readUInt32BE(track),
        insert = track + trackSize;
      const nested = Buffer.concat([source.subarray(0, insert), zeroBox, source.subarray(insert)]);
      nested.writeUInt32BE(trackSize + 10, track);
      nested.writeUInt32BE(source.readUInt32BE(movie) + 10, movie);
      const nestedPath = await put('nested-padding.mp4', nested);
      assert.equal((await confirmCompressedVideoDuplicate(base, nestedPath, [f.root])).recycleEligible, false);
      implicit.copy(nested, insert);
      const implicitNestedPath = await put('nested-all-zero-eof.mp4', nested);
      assert.equal((await confirmCompressedVideoDuplicate(base, implicitNestedPath, [f.root])).recycleEligible, false);

      const first = Buffer.from(typed),
        second = Buffer.from(typed);
      first[9] = 1;
      second[9] = 2;
      const ordered = await put('ordered.mp4', Buffer.concat([source, first, second]));
      const reordered = await put('reordered.mp4', Buffer.concat([source, second, first, zeroBox]));
      assert.equal((await confirmCompressedVideoDuplicate(ordered, reordered, [f.root])).recycleEligible, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'declared movie presentation hold and opaque per-track metadata ownership are preserved',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const base = await f.generate('base.mp4', [...video, ...encoded]);
      const source = await readFile(base);
      const held = Buffer.from(source),
        mvhd = held.indexOf(Buffer.from('mvhd'));
      assert.equal(held[mvhd + 4], 0);
      held.writeUInt32BE(held.readUInt32BE(mvhd + 20) + 1000, mvhd + 20);
      const longPresentation = join(f.root, 'held.mp4');
      await writeFile(longPresentation, held);
      const timing = await confirmCompressedVideoDuplicate(longPresentation, base, [f.root]);
      assert.equal(timing.verified, true, timing.reason ?? '');
      assert.equal(timing.recycleEligible, false);
      assert.match(timing.reason!, /mvhd/);
      const external = Buffer.from(source),
        reference = external.indexOf(Buffer.from('dref'));
      assert.ok(reference >= 0);
      external.writeUInt32BE(0, reference + 20); // Clear the URL entry's self-contained flag.
      const externalPath = join(f.root, 'external-reference.mp4');
      await writeFile(externalPath, external);
      const referenceProof = await confirmCompressedVideoDuplicate(externalPath, base, [f.root]);
      assert.equal(referenceProof.recycleEligible, false);

      const dual = await f.generate('dual.mp4', ['-i', base, '-map', '0:v', '-map', '0:v', '-c', 'copy']);
      const bytes = await readFile(dual);
      let movie = -1,
        movieEnd = -1;
      for (let p = 0; p < bytes.length;) {
        const n = bytes.readUInt32BE(p);
        if (bytes.toString('latin1', p + 4, p + 8) === 'moov') {
          movie = p;
          movieEnd = p + n;
          break;
        }
        p += n;
      }
      assert.ok(movie >= 0);
      const tracks: Array<[number, number]> = [];
      for (let p = movie + 8; p < movieEnd;) {
        const n = bytes.readUInt32BE(p);
        if (bytes.toString('latin1', p + 4, p + 8) === 'trak') tracks.push([p, n]);
        p += n;
      }
      assert.equal(tracks.length, 2);
      const decorate = (labels: string[]) => {
        let decorated = Buffer.from(bytes);
        for (let i = tracks.length - 1; i >= 0; i--) {
          const [p, n] = tracks[i]!;
          const box = Buffer.alloc(12);
          box.writeUInt32BE(12);
          box.write('zzzz', 4);
          box.write(labels[i]!, 8);
          decorated = Buffer.concat([decorated.subarray(0, p + n), box, decorated.subarray(p + n)]);
          decorated.writeUInt32BE(n + 12, p);
        }
        decorated.writeUInt32BE(bytes.readUInt32BE(movie) + 24, movie);
        return decorated;
      };
      const a = join(f.root, 'owned-a.mp4'),
        b = join(f.root, 'owned-b.mp4');
      await writeFile(a, decorate(['AAAA', 'BBBB']));
      await writeFile(b, decorate(['BBBB', 'AAAA']));
      const ownership = await confirmCompressedVideoDuplicate(a, b, [f.root]);
      assert.equal(ownership.verified, true, ownership.reason ?? '');
      assert.equal(ownership.recycleEligible, false);
      assert.match(ownership.reason!, /trak\[0\].*zzzz/);
    } finally {
      await f.close();
    }
  },
);

test('H264 SEI survives exact MP4 remux proof with all samples and metadata covered', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('source.mp4', [...video, ...encoded, '-metadata', 'title=Synthetic preserved title']);
    const b = await f.generate('remux.mp4', ['-i', a, '-map', '0', '-c', 'copy', '-movflags', '+faststart']);
    const before = [await readFile(a), await readFile(b)],
      expected = [await stamp(a), await stamp(b)] as const;
    const proof = await confirmCompressedVideoDuplicate(a, b, [f.root], { expectedStamps: expected });
    assert.equal(proof.verified, true, proof.reason ?? '');
    assert.equal(proof.recycleEligible, true, proof.reason ?? '');
    assert.equal(proof.coverage?.tracks[0]?.packets, 30);
    assert.equal(proof.coverage?.timingToleranceSeconds, 0.000002);
    assert.equal(proof.auxiliary.containerPayloadsCovered, true);
    assert.deepEqual([await readFile(a), await readFile(b)], before);
    assert.deepEqual([await stamp(a), await stamp(b)], expected);
  } finally {
    await f.close();
  }
});

test('full audio tracks compare every AAC packet including skip-sample side data', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('audio.mp4', [
      ...video,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=500:sample_rate=48000:duration=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-bf',
      '0',
      '-c:a',
      'aac',
    ]);
    const b = await f.generate('audio-remux.mp4', ['-i', a, '-map', '0', '-c', 'copy']);
    const proof = await confirmCompressedVideoDuplicate(a, b, [f.root]);
    assert.equal(proof.verified, true, proof.reason ?? '');
    assert.equal(proof.recycleEligible, true, proof.reason ?? '');
    assert.equal(proof.coverage?.tracks.length, 2);
    assert.ok(proof.coverage!.tracks[1]!.packets > 100);
    const different = await f.generate('different-audio.mp4', [
      '-i',
      a,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=900:sample_rate=48000:duration=3',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
    ]);
    assert.equal((await confirmCompressedVideoDuplicate(a, different, [f.root])).verified, false);
  } finally {
    await f.close();
  }
});

test(
  'explicit remux clip maps all packets but inter-frame decoder state remains review',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const retained = await f.generate('long.mp4', [...video, ...encoded]);
      const candidate = await f.generate('clip.mp4', [
        '-ss',
        '1',
        '-i',
        retained,
        '-t',
        '1',
        '-map',
        '0',
        '-c',
        'copy',
      ]);
      const proof = await confirmCompressedVideoDuplicate(candidate, retained, [f.root], { retainedOffsetSeconds: 1 });
      assert.equal(proof.verified, true, proof.reason ?? '');
      assert.equal(proof.recycleEligible, false);
      assert.match(proof.reason!, /decoder-reference-state/);
      assert.equal((await confirmCompressedVideoDuplicate(candidate, retained, [f.root])).verified, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'reencoded frames, low resolution, meaningful tags, and extra tracks do not gain exact proof',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const a = await f.generate('base.mp4', [...video, ...encoded]);
      const changed = await f.generate('changed.mp4', [
        '-i',
        a,
        '-vf',
        'drawbox=x=0:y=0:w=4:h=4:color=red:t=fill',
        ...encoded,
      ]);
      const low = await f.generate('low.mp4', ['-i', a, '-vf', 'scale=32:24', ...encoded]);
      const metadata = await f.generate('tag.mp4', ['-i', a, '-c', 'copy', '-metadata', 'title=Unique title']);
      const extra = await f.generate('extra.mp4', [
        '-i',
        a,
        '-f',
        'lavfi',
        '-i',
        'sine=duration=3',
        '-map',
        '0',
        '-map',
        '1',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
      ]);
      for (const b of [changed, low, metadata, extra]) {
        const proof = await confirmCompressedVideoDuplicate(a, b, [f.root]);
        assert.equal(proof.verified, false, `${b}: ${proof.reason}`);
        assert.equal(proof.recycleEligible, false);
      }
    } finally {
      await f.close();
    }
  },
);

test('opaque MP4 boxes and unreferenced mdat bytes are preserved or held', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('base.mp4', [...video, ...encoded]);
    const b = join(f.root, 'opaque.mp4');
    await copyFile(a, b);
    const box = Buffer.alloc(12);
    box.writeUInt32BE(12);
    box.write('zzzz', 4);
    box.write('DATA', 8);
    await appendFile(b, box);
    const proof = await confirmCompressedVideoDuplicate(a, b, [f.root]);
    assert.equal(proof.verified, true, proof.reason ?? '');
    assert.equal(proof.recycleEligible, false);
    assert.match(proof.reason!, /Opaque/);
    const c = join(f.root, 'opaque-copy.mp4');
    await copyFile(b, c);
    assert.equal((await confirmCompressedVideoDuplicate(b, c, [f.root])).recycleEligible, true);
    box.write('mdat', 4);
    await appendFile(c, box);
    const unreferenced = await confirmCompressedVideoDuplicate(b, c, [f.root]);
    assert.equal(unreferenced.recycleEligible, false);
    assert.match(unreferenced.reason!, /Unreferenced/);
  } finally {
    await f.close();
  }
});

test(
  'scope, hardlink alias, stale stamp, mutation, cancellation and timeout fail closed',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const a = await f.generate('long.mp4', [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=64x48:rate=10:duration=30',
        ...encoded,
      ]);
      const b = join(f.root, 'copy.mp4');
      await copyFile(a, b);
      assert.equal((await confirmCompressedVideoDuplicate(a, b, [join(f.root, 'outside')])).verified, false);
      const alias = join(f.root, 'alias.mp4');
      await link(a, alias);
      assert.match((await confirmCompressedVideoDuplicate(a, alias, [f.root])).reason!, /identity/);
      const expected = [await stamp(a), await stamp(b)] as const;
      await appendFile(b, Buffer.alloc(8));
      assert.match(
        (await confirmCompressedVideoDuplicate(a, b, [f.root], { expectedStamps: expected })).reason!,
        /changed/,
      );
      await copyFile(a, b);
      const controller = new AbortController();
      controller.abort();
      assert.equal(
        (await confirmCompressedVideoDuplicate(a, b, [f.root], { signal: controller.signal })).verified,
        false,
      );
      assert.match((await confirmCompressedVideoDuplicate(a, b, [f.root], { timeoutMs: 1 })).reason!, /timed out/);
      let mutation: Promise<void> | undefined;
      const mutated = await confirmCompressedVideoDuplicate(a, b, [f.root], {
        onProgress: () => {
          mutation ??= appendFile(b, Buffer.from('changed'));
        },
      });
      await mutation;
      assert.equal(mutated.verified, false, mutated.reason ?? '');
      assert.match(mutated.reason!, /changed/i);
      await copyFile(a, b);
      const mid = new AbortController();
      const cancelled = await confirmCompressedVideoDuplicate(a, b, [f.root], {
        signal: mid.signal,
        onProgress: () => mid.abort(),
      });
      assert.equal(cancelled.verified, false);
      assert.equal(cancelled.recycleEligible, false);
      const concurrent = await Promise.all([
        confirmCompressedVideoDuplicate(a, b, [f.root]),
        confirmCompressedVideoDuplicate(a, b, [f.root]),
      ]);
      assert.ok(
        concurrent.every((proof) => proof.recycleEligible),
        concurrent.map((proof) => proof.reason).join('; '),
      );
    } finally {
      await f.close();
    }
  },
);
