import { largeFileId, mockFileIds } from './helpers/file-identity.ts';
import { useMediaFixture } from './helpers/tool-fixtures.ts';
import { after as afterTools } from 'node:test';
const cleanTools = useMediaFixture();
afterTools(cleanTools);
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, copyFile, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMediaExecutables } from '../src/server/media-decoder.ts';
import { verifyFullVideoDuplicate } from '../src/server/media-video-confirmation.ts';
import type { MediaFileStamp } from '../src/server/media-confirmation.ts';

const binaries = findMediaExecutables(process.cwd());
const enabled = !!binaries.ffmpeg && !!binaries.ffprobe;
const execute = promisify(execFile);
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-full-video-fixture-')));
  const generate = async (name: string, args: string[]) => {
    const path = join(root, name);
    await execute(
      binaries.ffmpeg!,
      ['-nostdin', '-hide_banner', '-v', 'error', '-threads', '1', '-filter_threads', '1', '-y', ...args, path],
      { windowsHide: true, timeout: 30000 },
    );
    return path;
  };
  return { root, generate, close: () => rm(root, { recursive: true, force: true }) };
}
const lossless = ['-an', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p'];
const source = ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10:duration=2'];

test('video identity guards and stored stamps retain high file-ID bits', { skip: !enabled }, async (t) => {
  const f = await fixture();
  t.after(f.close);
  const a = await f.generate('id-a.mkv', [...source, ...lossless]),
    b = join(f.root, 'id-b.mkv');
  await copyFile(a, b);
  const ids = mockFileIds(t, [
    [a, largeFileId],
    [b, largeFileId + 1n],
  ]);
  const expected = [await stamp(a), await stamp(b)] as const;
  const report = await verifyFullVideoDuplicate(a, b, [f.root], { expectedStamps: expected });
  assert.equal(report.verified, true);
  assert.equal(report.stamps[0].ino, String(largeFileId));
  assert.doesNotThrow(() => JSON.stringify(report));
  const legacy = expected.map((value) => ({ ...value, ino: Number(value.ino) })) as [MediaFileStamp, MediaFileStamp];
  assert.equal((await verifyFullVideoDuplicate(a, b, [f.root], { expectedStamps: legacy })).verified, true);
  ids.set(a, largeFileId + 1n);
  await assert.rejects(verifyFullVideoDuplicate(a, b, [f.root]), /same underlying/);
  ids.set(a, largeFileId + 2n);
  await assert.rejects(verifyFullVideoDuplicate(a, b, [f.root], { expectedStamps: expected }), /changed since/);
  ids.set(a, largeFileId);
  const changed = await verifyFullVideoDuplicate(a, b, [f.root], {
    onProgress: () => {
      ids.set(a, largeFileId + 2n);
    },
  });
  assert.equal(changed.verified, false);
  assert.match(changed.reason!, /changed/);
});
async function stamp(path: string): Promise<MediaFileStamp> {
  const info = await lstat(path);
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: String((await lstat(path, { bigint: true })).ino),
  };
}

test(
  'every frame/time in identical lossless videos is proven and both source stamps remain untouched',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const a = await f.generate('a.mkv', [...source, ...lossless]);
      const b = join(f.root, 'b.mkv');
      await copyFile(a, b);
      const expected = [await stamp(a), await stamp(b)] as const;
      const bytes = [await readFile(a), await readFile(b)];
      const report = await verifyFullVideoDuplicate(a, b, [f.root], { expectedStamps: expected });
      assert.equal(report.verified, true, report.reason ?? '');
      assert.equal(report.recycleEligible, true);
      assert.equal(report.assessment, 'identical-native-grid');
      assert.equal(report.coverage?.candidateFrames, 20);
      assert.equal(report.coverage?.allCandidateFramesCompared, true);
      assert.equal(report.audio?.method, 'absent-in-both');
      assert.equal(report.quality?.actualQualityEstablished, true);
      assert.deepEqual(report.stamps, expected);
      assert.deepEqual([await readFile(a), await readFile(b)], bytes);
      assert.deepEqual([await stamp(a), await stamp(b)], expected);
    } finally {
      await f.close();
    }
  },
);

test(
  'a complete lossless short clip is covered by an explicitly mapped interval of a longer video',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const longer = await f.generate('long.mkv', [...source, ...lossless]);
      const shorter = await f.generate('short.mkv', ['-ss', '0.5', '-i', longer, '-t', '1', ...lossless]);
      const report = await verifyFullVideoDuplicate(shorter, longer, [f.root], { retainedOffsetSeconds: 0.5 });
      assert.equal(report.verified, true, report.reason ?? '');
      assert.equal(report.coverage?.candidateFrames, 10);
      assert.deepEqual(report.coverage?.retainedInterval, [0.5, 1.5]);
      const wrong = await verifyFullVideoDuplicate(shorter, longer, [f.root], { retainedOffsetSeconds: 0.4 });
      assert.equal(wrong.recycleEligible, false);
      assert.equal(wrong.coverage?.decodedPixelsEqual, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'ordinary lossy encoding gets metrics for every full frame and explicit quality-review evidence',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const retained = await f.generate('master.mkv', [...source, ...lossless]);
      const lossy = await f.generate('lossy.mkv', [
        '-i',
        retained,
        '-an',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'ultrafast',
        '-crf',
        '12',
        '-pix_fmt',
        'yuv420p',
      ]);
      const report = await verifyFullVideoDuplicate(lossy, retained, [f.root]);
      assert.equal(report.coverage?.decodedPixelsEqual, false, report.reason ?? '');
      assert.equal(report.statistical?.frames, 20, report.reason ?? '');
      assert.equal(report.statistical?.allFramesCompared, true);
      assert.equal(report.statistical?.reviewRequired, true);
      assert.equal(report.quality?.measurements?.allFramesMeasured, true, report.reason ?? '');
      assert.equal(report.quality?.measurements?.frames, 20);
      assert.ok(Number.isFinite(report.quality?.measurements?.commonGrid.candidate.meanBlurWidth));
      assert.ok(Number.isFinite(report.quality?.measurements?.nativeGrid.retained.meanBlockArtifacts));
      assert.equal(report.quality?.actualQualityEstablished, false);
      assert.equal(report.recycleEligible, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'one inserted visual edit cannot qualify even if all other frames are exactly identical',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const retained = await f.generate('master.mkv', [...source, ...lossless]);
      const edited = await f.generate('edited.mkv', [
        '-i',
        retained,
        '-vf',
        "drawbox=x=0:y=0:w=64:h=48:color=black:t=fill:enable='eq(n,7)'",
        ...lossless,
      ]);
      const report = await verifyFullVideoDuplicate(edited, retained, [f.root]);
      assert.equal(report.verified, false);
      assert.equal(report.coverage?.candidateFrames, 20, report.reason ?? '');
      assert.equal(report.statistical?.thresholdPassed, false, report.reason ?? '');
      assert.equal(report.assessment, 'different');
    } finally {
      await f.close();
    }
  },
);

test(
  'full PCM audio differs despite identical video and therefore blocks any visual-only recycling',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const video = await f.generate('video.mkv', [...source, ...lossless]);
      const audio = async (name: string, frequency: number) =>
        f.generate(name, [
          '-i',
          video,
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${frequency}:sample_rate=8000:duration=2`,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          '-c:a',
          'pcm_s16le',
        ]);
      const a = await audio('a.mkv', 500),
        b = await audio('b.mkv', 750);
      const report = await verifyFullVideoDuplicate(a, b, [f.root]);
      assert.equal(report.coverage?.decodedPixelsEqual, true, report.reason ?? '');
      assert.equal(report.audio?.covered, false);
      assert.match(report.reason!, /audio/);
      assert.equal(report.recycleEligible, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'lower-resolution lossy candidate reports common/native quality and never qualifies through dimensions alone',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const retained = await f.generate('large.mkv', [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=128x96:rate=10:duration=2',
        ...lossless,
      ]);
      const candidate = await f.generate('small.mkv', [
        '-i',
        retained,
        '-vf',
        'scale=64:48:flags=area+accurate_rnd+bitexact',
        '-an',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'ultrafast',
        '-crf',
        '4',
        '-pix_fmt',
        'yuv420p',
      ]);
      const report = await verifyFullVideoDuplicate(candidate, retained, [f.root]);
      assert.equal(report.coverage?.allCandidateFramesCompared, true, report.reason ?? '');
      assert.equal(report.statistical?.thresholdPassed, true, report.reason ?? '');
      assert.equal(report.quality?.measurements?.allFramesMeasured, true, report.reason ?? '');
      assert.deepEqual(report.quality?.candidateDimensions, [64, 48]);
      assert.deepEqual(report.quality?.retainedDimensions, [128, 96]);
      const native = report.quality!.measurements!.nativeGrid;
      assert.equal(native.candidate.meanNormalizedBlurWidth, native.candidate.meanBlurWidth / 64);
      assert.equal(native.retained.meanNormalizedBlurWidth, native.retained.meanBlurWidth / 128);
      assert.equal(report.quality?.actualQualityEstablished, false);
      assert.equal(report.recycleEligible, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'complete short interval includes exact original PCM samples at its mapped offset',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const longer = await f.generate('audio-long.mkv', [
        ...source,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=503:sample_rate=8000:duration=2',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'ffv1',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
      ]);
      const shorter = await f.generate('audio-short.mkv', [
        '-ss',
        '0.5',
        '-i',
        longer,
        '-t',
        '1',
        '-c:v',
        'ffv1',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
      ]);
      const report = await verifyFullVideoDuplicate(shorter, longer, [f.root], { retainedOffsetSeconds: 0.5 });
      assert.equal(report.recycleEligible, true, report.reason ?? '');
      assert.equal(report.coverage?.candidateFrames, 10);
      assert.equal(report.audio?.covered, true);
      assert.equal(report.audio?.samples, 8000);
      assert.equal(report.audio?.method, 'identical-full-pcm');
    } finally {
      await f.close();
    }
  },
);

test('64-bit integer audio cannot be declared exact after a lossy float64 conversion', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('s64.mkv', [
      ...source,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=503:sample_rate=8000:duration=2',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'ffv1',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'pcm_s64le',
    ]);
    const b = join(f.root, 's64-copy.mkv');
    await copyFile(a, b);
    const report = await verifyFullVideoDuplicate(a, b, [f.root]);
    assert.equal(report.recycleEligible, false);
    assert.match(report.reason!, /Unsupported audio/);
  } finally {
    await f.close();
  }
});

test(
  'equal downscaled pixels in a larger grid do not prove genuinely higher retained quality',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const candidate = await f.generate('native.mkv', [...source, ...lossless]);
      const enlarged = await f.generate('upscale.mkv', [
        '-i',
        candidate,
        '-vf',
        'scale=128:96:flags=neighbor',
        ...lossless,
      ]);
      const report = await verifyFullVideoDuplicate(candidate, enlarged, [f.root]);
      assert.equal(report.coverage?.decodedPixelsEqual, true, report.reason ?? '');
      assert.equal(report.quality?.candidateNativeGridPreserved, true);
      assert.equal(report.quality?.actualQualityEstablished, false);
      assert.equal(report.recycleEligible, false);
      assert.equal(report.statistical?.allFramesCompared, true);
    } finally {
      await f.close();
    }
  },
);

test(
  'equal PCM bytes with a midstream timestamp gap are not interchangeable audiovisual content',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const retained = await f.generate('contiguous.mov', [
        ...source,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=503:sample_rate=8000:duration=2',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'rawvideo',
        '-threads',
        '1',
        '-pix_fmt',
        'rgb24',
        '-c:a',
        'alac',
      ]);
      const candidate = await f.generate('gap.mov', [
        '-i',
        retained,
        '-c:v',
        'copy',
        '-af',
        "asetpts='PTS+gte(T,1)*0.25/TB'",
        '-c:a',
        'alac',
      ]);
      const report = await verifyFullVideoDuplicate(candidate, retained, [f.root]);
      assert.equal(report.coverage?.decodedPixelsEqual, true, report.reason ?? '');
      const detail = await execute(binaries.ffprobe!, [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_frames',
        '-show_packets',
        '-show_entries',
        'packet=pts,duration:frame=pts,duration,nb_samples',
        '-of',
        'compact',
        candidate,
      ]);
      const clock = detail.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('frame|'))
        .map((line) =>
          Object.fromEntries(
            line
              .split('|')
              .slice(1)
              .map((field) => field.split('=')),
          ),
        );
      assert.ok(
        clock.some(
          (frame, index) =>
            index > 0 && Number(frame.pts) !== Number(clock[index - 1]!.pts) + Number(clock[index - 1]!.nb_samples),
        ),
        'fixture must contain an observable real audio clock gap',
      );
      assert.equal(report.audio?.samplesIdentical, true, report.reason ?? '');
      assert.equal(report.audio?.timingVerified, false);
      assert.equal(report.audio?.covered, false);
      assert.equal(report.recycleEligible, false);
      assert.match(report.reason!, /timestamp/);
    } finally {
      await f.close();
    }
  },
);

test(
  'semantic audio disposition cannot be discarded because pixels and PCM are identical',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const retained = await f.generate('plain.mkv', [
        ...source,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=503:sample_rate=8000:duration=2',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'ffv1',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
      ]);
      const candidate = await f.generate('original.mkv', ['-i', retained, '-c', 'copy', '-disposition:a', 'original']);
      const report = await verifyFullVideoDuplicate(candidate, retained, [f.root]);
      assert.equal(report.metadataCovered, false, report.reason ?? '');
      assert.equal(report.recycleEligible, false);
      assert.match(report.reason!, /metadata/);
    } finally {
      await f.close();
    }
  },
);

test(
  'decoded-frame auxiliary SEI is scanned and held even when the video copies decode identically',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const candidate = await f.generate('sei.mkv', [
        ...source,
        '-an',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'ultrafast',
        '-crf',
        '0',
        '-pix_fmt',
        'yuv420p',
      ]);
      const retained = join(f.root, 'sei-copy.mkv');
      await copyFile(candidate, retained);
      const report = await verifyFullVideoDuplicate(candidate, retained, [f.root]);
      assert.equal(report.coverage?.decodedPixelsEqual, true, report.reason ?? '');
      assert.equal(report.auxiliary?.supported, false);
      assert.ok(report.auxiliary?.reasons.some((reason) => /User Data.*SEI/i.test(reason)));
      assert.equal(report.metadataCovered, false);
      assert.equal(report.recycleEligible, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'retained semantic dispositions also cannot reinterpret otherwise identical streams',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const candidate = await f.generate('plain-video.mkv', [...source, ...lossless]);
      const retained = await f.generate('comment-video.mkv', [
        '-i',
        candidate,
        '-c',
        'copy',
        '-disposition:v',
        'comment',
      ]);
      const report = await verifyFullVideoDuplicate(candidate, retained, [f.root]);
      assert.equal(report.recycleEligible, false);
      assert.equal(report.metadataCovered, false);
    } finally {
      await f.close();
    }
  },
);

test('PQ HDR transfer and changed native audio rate require separate verification', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const hdr = await f.generate('hdr.mkv', [
      ...source,
      '-vf',
      'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
      '-an',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-preset',
      'ultrafast',
      '-crf',
      '0',
      '-pix_fmt',
      'yuv420p',
    ]);
    const hdrProbe = await execute(binaries.ffprobe!, [
      '-v',
      'error',
      '-show_entries',
      'stream=color_transfer',
      '-of',
      'compact',
      hdr,
    ]);
    assert.match(hdrProbe.stdout, /smpte2084/, 'fixture must expose actual PQ HDR transfer');
    const hdrCopy = join(f.root, 'hdr-copy.mkv');
    await copyFile(hdr, hdrCopy);
    const hdrReport = await verifyFullVideoDuplicate(hdr, hdrCopy, [f.root]);
    assert.equal(hdrReport.recycleEligible, false);
    assert.match(hdrReport.reason!, /HDR/);
    const audio = async (name: string, rate: number) =>
      f.generate(name, [
        ...source,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=503:sample_rate=${rate}:duration=2`,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'ffv1',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
      ]);
    const a = await audio('rate8000.mkv', 8000),
      b = await audio('rate16000.mkv', 16000);
    const report = await verifyFullVideoDuplicate(a, b, [f.root]);
    assert.equal(report.recycleEligible, false);
    assert.match(report.reason!, /audio.*layout/);
  } finally {
    await f.close();
  }
});

test('mid-flight cancellation aborts and joins the active backpressured decoders', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('long-synthetic.mkv', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x48:rate=10:duration=300',
      ...lossless,
    ]);
    const b = join(f.root, 'long-copy.mkv');
    await copyFile(a, b);
    const before = [await stamp(a), await stamp(b)];
    const controller = new AbortController();
    let observed = 0;
    await assert.rejects(
      verifyFullVideoDuplicate(a, b, [f.root], {
        signal: controller.signal,
        onProgress: ({ stage, frames }) => {
          if (stage === 'video' && frames === 120) {
            observed = frames;
            controller.abort(new Error('synthetic live cancellation'));
          }
        },
      }),
      /synthetic live cancellation/,
    );
    assert.equal(observed, 120);
    assert.deepEqual([await stamp(a), await stamp(b)], before);
  } finally {
    await f.close();
  }
});

test(
  'different native chroma siting is held even when the decoded sample planes match',
  { skip: !enabled },
  async () => {
    const f = await fixture();
    try {
      const encode = (name: string, location: number) =>
        f.generate(name, [
          ...source,
          '-an',
          '-c:v',
          'libx264',
          '-threads',
          '1',
          '-preset',
          'ultrafast',
          '-crf',
          '0',
          '-pix_fmt',
          'yuv420p',
          '-x264-params',
          `chromaloc=${location}`,
        ]);
      const a = await encode('left.mkv', 0),
        b = await encode('center.mkv', 1);
      const report = await verifyFullVideoDuplicate(a, b, [f.root]);
      assert.equal(report.coverage?.decodedPixelsEqual, true, report.reason ?? '');
      assert.deepEqual(report.auxiliary?.nativeChromaLocations, ['left', 'center']);
      assert.ok(report.auxiliary?.reasons.some((reason) => /chroma/.test(reason)));
      assert.equal(report.recycleEligible, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'active audio and quality streaming can each be cancelled without leaving decoder joins pending',
  { skip: !enabled },
  async (t) => {
    const f = await fixture();
    try {
      const video = await f.generate('streaming-video.mkv', [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=64x48:rate=10:duration=300',
        ...lossless,
      ]);
      const audio = await f.generate('streaming-audio.mkv', [
        '-i',
        video,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=503:sample_rate=8000:duration=300',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'pcm_s16le',
      ]);
      const quality = await f.generate('streaming-quality.mkv', [
        '-i',
        video,
        '-an',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'ultrafast',
        '-crf',
        '0',
        '-pix_fmt',
        'yuv420p',
      ]);
      for (const [stage, sourcePath] of [
        ['audio', audio],
        ['quality', quality],
      ] as const) {
        await t.test(stage, { timeout: 120000 }, async (t) => {
          const retained = join(f.root, `${stage}-copy.mkv`);
          await copyFile(sourcePath, retained);
          const before = [await stamp(sourcePath), await stamp(retained)];
          const controller = new AbortController();
          let framesObserved = 0;
          let joinTimer: ReturnType<typeof setTimeout> | undefined;
          let rejectJoin!: (error: Error) => void;
          const joined = new Promise<never>((_resolve, reject) => {
            rejectJoin = reject;
          });
          const verification = verifyFullVideoDuplicate(sourcePath, retained, [f.root], {
            signal: AbortSignal.any([controller.signal, t.signal]),
            onProgress: (progress) => {
              if (progress.stage === stage && progress.frames === 120) {
                framesObserved = 120;
                // Time the cancellation/join itself, independently of fixture creation and full pre-scans.
                joinTimer = setTimeout(() => rejectJoin(new Error(`${stage} decoder joins pending`)), 10000);
                controller.abort(new Error(`synthetic ${stage} cancellation`));
              }
            },
          });
          try {
            await assert.rejects(Promise.race([verification, joined]), new RegExp(`synthetic ${stage} cancellation`));
          } finally {
            clearTimeout(joinTimer);
          }
          assert.equal(framesObserved, 120);
          assert.deepEqual([await stamp(sourcePath), await stamp(retained)], before);
        });
      }
    } finally {
      await f.close();
    }
  },
);

test('unique metadata and candidate discovery stamp changes fail closed', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('a.mkv', [...source, '-metadata', 'title=unique candidate title', ...lossless]);
    const b = await f.generate('b.mkv', [...source, ...lossless]);
    const unique = await verifyFullVideoDuplicate(a, b, [f.root]);
    assert.equal(unique.recycleEligible, false);
    assert.equal(unique.metadataCovered, false);
    const expected = [await stamp(a), await stamp(b)] as const;
    await appendFile(a, 'changed');
    await assert.rejects(verifyFullVideoDuplicate(a, b, [f.root], { expectedStamps: expected }), /changed/);
  } finally {
    await f.close();
  }
});

test('source mutation after full frame scanning cannot publish a successful proof', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('a.mkv', [...source, ...lossless]);
    const b = join(f.root, 'b.mkv');
    await copyFile(a, b);
    let mutation: Promise<void> | undefined;
    const report = await verifyFullVideoDuplicate(a, b, [f.root], {
      onProgress: ({ stage }) => {
        if (stage === 'video' && !mutation) mutation = appendFile(a, 'changed');
      },
    });
    await mutation;
    assert.equal(report.recycleEligible, false);
    assert.match(report.reason!, /changed/);
  } finally {
    await f.close();
  }
});

test('cancellation stops only the verification children without changing input files', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const a = await f.generate('a.mkv', [...source, ...lossless]);
    const b = join(f.root, 'b.mkv');
    await copyFile(a, b);
    const before = [await stamp(a), await stamp(b)];
    const controller = new AbortController();
    controller.abort(new Error('synthetic cancel'));
    await assert.rejects(verifyFullVideoDuplicate(a, b, [f.root], { signal: controller.signal }), /synthetic cancel/);
    assert.deepEqual([await stamp(a), await stamp(b)], before);
  } finally {
    await f.close();
  }
});
