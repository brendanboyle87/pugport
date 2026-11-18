import { after as afterTools } from 'node:test';
const cleanTools = useMediaFixture();
afterTools(cleanTools);
import { useMediaFixture } from './helpers/tool-fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { DatabaseSync } from 'node:sqlite';
import {
  MediaAnalysisManager,
  compareVideoSamples,
  samplingTimes,
  verifyMediaRetainedCopy,
} from '../src/server/media-analysis.ts';
import {
  createMediaDecoder,
  findMediaExecutables,
  frameSignature,
  mediaSide,
  runMediaCommand,
  type FrameSignature,
  type MediaDecoder,
} from '../src/server/media-decoder.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-')));
  const media = join(root, 'media');
  await mkdir(media);
  return { root, media, close: () => rm(root, { recursive: true, force: true }) };
}
const colour = [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25];
function frame(index: number, time = index): FrameSignature {
  let seed = index + 101,
    bits = '';
  for (let i = 0; i < 16; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bits += (seed >>> 28).toString(16);
  }
  return { time, hash: bits, texture: 60, colours: colour };
}
function mockDecoder(overrides: Partial<MediaDecoder> = {}): MediaDecoder {
  return {
    description: 'synthetic media fixtures',
    image: async () => frame(1),
    probe: async () => ({ duration: 23 }),
    frame: async (_path, time) => frame(Math.round(time), time),
    ...overrides,
  };
}
async function fakeVideo(folder: string, name: string) {
  const path = join(folder, name);
  await writeFile(path, `synthetic encoded bytes for ${name}`);
  return path;
}

test('video samples separate full span, partial overlap and single-frame/static coincidences', () => {
  const full = Array.from({ length: 24 }, (_, i) => frame(i, i));
  const copied = full.map((item) => ({ ...item }));
  assert.equal(compareVideoSamples(full, copied, 23, 23)?.coverage, 'sampled-full-span');
  const clipped = full.slice(7, 16).map((item) => ({ ...item, time: item.time - 7 }));
  const overlap = compareVideoSamples(full, clipped, 23, 8);
  assert.equal(overlap?.coverage, 'partial-overlap');
  assert.equal(overlap?.offsetSeconds, -7);
  assert.deepEqual(overlap?.spanA, [7, 15]);
  assert.equal(overlap?.sampledContainment?.contained, 'b');
  assert.equal(overlap?.sampledContainment?.container, 'a');
  assert.equal(compareVideoSamples(clipped, full, 8, 23)?.sampledContainment?.contained, 'a');
  const onlyMiddle = clipped.slice(1, -1);
  assert.equal(
    compareVideoSamples(full, onlyMiddle, 23, 8)?.sampledContainment,
    undefined,
    'matching every supplied sample in the middle cannot claim short-video endpoint coverage',
  );
  const drifted = clipped.map((item, index) => ({ ...item, time: item.time + index * 0.1 }));
  assert.equal(compareVideoSamples(full, drifted, 23, 9)?.sampledContainment, undefined);
  const unrelated = Array.from({ length: 24 }, (_, i) => frame(i + 300, i));
  unrelated[0] = full[0]!;
  assert.equal(compareVideoSamples(full, unrelated, 23, 23), undefined);
  const repeated = full.map((item) => ({ ...frame(1), time: item.time }));
  assert.equal(compareVideoSamples(repeated, repeated, 23, 23), undefined);
  const black = full.map((item) => ({ ...item, texture: 0 }));
  assert.equal(compareVideoSamples(black, black, 23, 23), undefined);
  assert.equal(samplingTimes(0.3).length, 24, 'short videos have no five-second exclusion');
  assert.ok(samplingTimes(200).at(-1)! > 199);
});

test('exact hashes are checkpointed, paginated and cannot authorize deletion', async () => {
  const f = await fixture();
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder: mockDecoder() });
  try {
    await writeFile(join(f.media, 'a.jpg'), 'same bytes');
    await copyFile(join(f.media, 'a.jpg'), join(f.media, 'b.jpg'));
    await copyFile(join(f.media, 'a.jpg'), join(f.media, 'c.jpg'));
    const started = await manager.start(
      { folders: [f.media] },
      { conversationId: 'one', workflowId: 'work-1', projectPath: f.media },
    );
    const result = await manager.wait(started.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.counts.files, 3);
    assert.equal(result.counts.results, 2);
    assert.ok(result.results.every((item) => item.classification === 'exact-bytes' && item.deleteEligible === false));
    assert.equal(result.owner?.conversationId, 'one');
    const page = manager.status(started.id, { limit: 1 });
    assert.equal(page.nextOffset, 1);
    assert.equal(manager.status(started.id, { offset: page.nextOffset!, limit: 1 }).nextOffset, null);
    assert.deepEqual(manager.list('other'), []);
    assert.equal(manager.list()[0]?.results.length, 0);
    const proof = await verifyMediaRetainedCopy(
      join(f.media, 'b.jpg'),
      join(f.media, 'a.jpg'),
      [f.media],
      new AbortController().signal,
    );
    assert.equal(proof.identical, true);
    await writeFile(join(f.media, 'a.jpg'), 'changed bytes');
    manager.resume(started.id);
    const refreshed = await manager.wait(started.id);
    const exact = refreshed.results.filter((item) => item.classification === 'exact-bytes');
    assert.equal(exact.length, 1);
    assert.ok(exact.every((item) => !item.a.endsWith('a.jpg') && !item.b.endsWith('a.jpg')));
    assert.equal(
      (
        await verifyMediaRetainedCopy(
          join(f.media, 'b.jpg'),
          join(f.media, 'a.jpg'),
          [f.media],
          new AbortController().signal,
        )
      ).identical,
      false,
    );
    assert.deepEqual(await readFile(join(f.media, 'b.jpg'), 'utf8'), 'same bytes');
    assert.throws(() => manager.resume(started.id, { conversationId: 'other', projectPath: f.media }), /transfer/);
    assert.throws(() => manager.resume(started.id, { conversationId: 'one', projectPath: f.root }), /transfer/);
    manager.resume(started.id, {
      conversationId: 'one',
      projectPath: f.media,
      workflowId: 'new-work',
      runId: 'new-run',
    });
    const rebound = await manager.wait(started.id);
    assert.equal(rebound.owner?.workflowId, 'new-work');
    assert.equal(rebound.owner?.runId, 'new-run');
  } finally {
    await manager.close();
    await f.close();
  }
});

test('video full span requires the extra aligned samples; audio is explicitly unverified', async () => {
  const f = await fixture();
  const updates: string[] = [];
  let decodes = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: mockDecoder({
      frame: async (_path, time) => {
        decodes++;
        return frame(Math.round(time), time);
      },
    }),
    onUpdate: (report) => updates.push(report.status),
  });
  try {
    await fakeVideo(f.media, 'a.mp4');
    await fakeVideo(f.media, 'b.mp4');
    const start = await manager.start({ folders: [f.media], kind: 'videos' });
    const result = await manager.wait(start.id);
    assert.equal(result.counts.results, 1);
    assert.equal(result.results[0]?.classification, 'sampled-full-span');
    // All six coarse positions agree, so eight aligned positions confirm the span (a weaker match gets 16).
    assert.deepEqual(result.results[0]?.visual?.fineCheck, { planned: 8, decoded: 8, matches: 8, failed: 0 });
    assert.equal(result.results[0]?.deleteEligible, false);
    assert.match(result.results[0]!.explanation, /音轨/);
    assert.ok(updates.includes('completed'));
    decodes = 0;
    manager.resume(start.id);
    const resumed = await manager.wait(start.id);
    assert.equal(decodes, 0, 'unchanged files and completed pair evidence need no new frame decoding');
    assert.equal(resumed.results[0]?.reusedFromCheckpoint, true);
    assert.equal(resumed.results[0]?.observedAt, result.results[0]?.observedAt);
  } finally {
    await manager.close();
    await f.close();
  }
});

test('a failed sample never becomes full coverage, and retry only decodes missing positions', async () => {
  const f = await fixture();
  let fail = true,
    calls = 0;
  const decoder = mockDecoder({
    frame: async (_path, time) => {
      calls++;
      // 8.96 s is one of the six coarse positions every video is sampled at.
      if (fail && time > 8.5 && time < 9.5) throw new Error('bad frame');
      return frame(Math.round(time), time);
    },
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder });
  try {
    await fakeVideo(f.media, 'a.mp4');
    await fakeVideo(f.media, 'b.mp4');
    const start = await manager.start({ folders: [f.media] });
    const result = await manager.wait(start.id);
    assert.equal(result.results[0]?.classification, 'partial-overlap');
    assert.ok(result.counts.errors > 0);
    assert.match(result.issues[0]!.error, /bad frame/);
    fail = false;
    calls = 0;
    manager.resume(start.id);
    const retried = await manager.wait(start.id);
    assert.equal(retried.results[0]?.classification, 'sampled-full-span');
    assert.equal(retried.counts.errors, 0);
    assert.ok(calls < 24 * 2 + 32, 'successful initial samples are reused');
  } finally {
    await manager.close();
    await f.close();
  }
});

test('pause and process restart reuse sub-file checkpoints; close is different from pause', async () => {
  const f = await fixture();
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: mockDecoder({
      frame: async (_path, time, signal) => {
        if (time > 3) {
          resolveReached();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
          );
        }
        return frame(Math.round(time), time);
      },
    }),
  });
  let second: MediaAnalysisManager | undefined;
  try {
    await fakeVideo(f.media, 'a.mp4');
    const start = await manager.start({ folders: [f.media] }, { conversationId: 'owner', workflowId: 'work' });
    await reached;
    manager.cancelForWorkflow('work');
    assert.equal((await manager.wait(start.id)).status, 'interrupted');
    await manager.close();
    let called = 0;
    second = new MediaAnalysisManager(join(f.root, 'data'), {
      decoder: mockDecoder({
        frame: async (_path, time) => {
          called++;
          assert.ok(time > 3, 'completed frames should not be decoded again');
          return frame(Math.round(time), time);
        },
      }),
    });
    assert.equal(second.list('owner')[0]?.id, start.id);
    second.resume(start.id);
    assert.equal((await second.wait(start.id)).status, 'completed');
    assert.ok(called > 0 && called < 24);
    second.cancel(start.id);
    assert.deepEqual(second.list(), []);
    assert.throws(() => second!.resume(start.id), /closed/);
  } finally {
    await second?.close();
    await f.close();
  }
});

test('decoder errors keep exact hashes, cap repeated failures, and state the uncovered files', async () => {
  const f = await fixture();
  let calls = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: mockDecoder({
      frame: async () => {
        calls++;
        throw new Error('unsupported synthetic codec');
      },
    }),
  });
  try {
    await fakeVideo(f.media, 'a.ts');
    await copyFile(join(f.media, 'a.ts'), join(f.media, 'b.ts'));
    const result = await manager.wait((await manager.start({ folders: [f.media] })).id);
    assert.equal(result.status, 'completed');
    assert.equal(result.counts.errors, 2);
    assert.equal(calls, 6);
    assert.equal(result.results[0]?.classification, 'exact-bytes');
    assert.ok(result.coverage.some((line) => line.includes('未完成画面解码')));
  } finally {
    await manager.close();
    await f.close();
  }
});

test('scope caps and source changes are visible; out-of-scope links never enter the file set', async (t) => {
  const f = await fixture();
  const external = join(f.root, 'external');
  await mkdir(external);
  await fakeVideo(external, 'outside.mp4');
  let linked = true;
  try {
    await symlink(external, join(f.media, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false;
  }
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: mockDecoder({
      image: async (path) => {
        await writeFile(path, `modified:${basename(path)}`);
        return frame(1);
      },
    }),
  });
  try {
    await writeFile(join(f.media, 'one.jpg'), 'one');
    await writeFile(join(f.media, 'two.jpg'), 'two');
    const result = await manager.wait((await manager.start({ folders: [f.media], maxFiles: 1 })).id);
    assert.equal(result.counts.files, 1);
    assert.equal(result.counts.results, 0);
    assert.match(result.issues[0]!.error, /changed during analysis/);
    assert.ok(result.coverage.some((line) => line.includes('上限')));
    if (!linked) t.diagnostic('OS denied synthetic symlink creation; rest of scope test still ran.');
    await assert.rejects(
      verifyMediaRetainedCopy(
        join(f.media, 'one.jpg'),
        join(external, 'outside.mp4'),
        [f.media],
        new AbortController().signal,
      ),
      /outside/,
    );
  } finally {
    await manager.close();
    await f.close();
  }
});

test('real image decode and ORB are bounded local operations; visual match remains a candidate', async () => {
  const f = await fixture();
  const pixels = Buffer.alloc(320 * 320 * 3);
  let seed = 23;
  for (let y = 0; y < 320; y += 16)
    for (let x = 0; x < 320; x += 16) {
      const rgb = Array.from({ length: 3 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed >>> 24;
      });
      for (let dy = 0; dy < 16; dy++)
        for (let dx = 0; dx < 16; dx++) for (let c = 0; c < 3; c++) pixels[((y + dy) * 320 + x + dx) * 3 + c] = rgb[c]!;
    }
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { appRoot: f.root });
  try {
    await sharp(pixels, { raw: { width: 320, height: 320, channels: 3 } })
      .png()
      .toFile(join(f.media, 'a.png'));
    await sharp(join(f.media, 'a.png')).resize(240).jpeg({ quality: 90 }).toFile(join(f.media, 'b.jpg'));
    const result = await manager.wait((await manager.start({ folders: [f.media], kind: 'images' })).id);
    assert.equal(result.counts.results, 1);
    assert.equal(result.results[0]?.classification, 'image-candidate');
    assert.ok((result.results[0]?.imageFineCheck?.geometricInliers ?? 0) > 20);
    assert.equal(result.results[0]?.deleteEligible, false);
    assert.equal(frameSignature(Buffer.alloc(mediaSide * mediaSide * 3)).texture, 0);
  } finally {
    await manager.close();
    await f.close();
  }
});

test('decoder process output caps, timeouts and cancellation kill only synthetic direct children', async () => {
  await assert.rejects(
    runMediaCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(40000))"], new AbortController().signal, {
      maxOutput: 32,
    }),
    /output limit/,
  );
  await assert.rejects(
    runMediaCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], new AbortController().signal, {
      timeoutMs: 80,
    }),
    /timed out/,
  );
  const signal = new AbortController();
  const run = runMediaCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], signal.signal);
  signal.abort();
  await assert.rejects(run, /cancelled/);
});

test('checkpoint write failure during close still aborts every job and releases the database', async () => {
  const f = await fixture();
  let reached!: () => void;
  const running = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: mockDecoder({
      frame: async (_path, _time, signal) => {
        reached();
        return new Promise<never>((_resolve, reject) => {
          const stop = () => reject(new Error('decoder stopped'));
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
        });
      },
    }),
  });
  const internal = manager as unknown as {
    db: DatabaseSync;
    active: Map<string, { abort: AbortController; done: Promise<void> }>;
  };
  try {
    await fakeVideo(f.media, 'a.mp4');
    await manager.start({ folders: [f.media] });
    await running;
    await manager.start({ folders: [f.media] });
    const tasks = [...internal.active.values()];
    assert.equal(tasks.length, 2);
    internal.db.exec('PRAGMA query_only=ON');
    const closing = manager.close();
    assert.equal(manager.close(), closing, 'close is idempotent even when persistence fails');
    await assert.rejects(closing, /checkpoint cleanup/);
    assert.ok(tasks.every((task) => task.abort.signal.aborted));
    await Promise.all(tasks.map((task) => task.done));
    assert.throws(() => internal.db.prepare('SELECT 1'), /not open|closed/i);
    const restored = new MediaAnalysisManager(join(f.root, 'data'), { decoder: mockDecoder() });
    try {
      assert.ok(restored.list().every((job) => job.status === 'interrupted'));
    } finally {
      await restored.close();
    }
  } finally {
    await manager.close().catch(() => {});
    await f.close();
  }
});

test('repeated start reuses active scoped work and immediate pause/resume really resumes', async () => {
  const f = await fixture();
  let reached!: () => void,
    first = true;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: mockDecoder({
      frame: async (_path, time, signal) => {
        if (first) {
          first = false;
          reached();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }),
          );
        }
        return frame(Math.round(time), time);
      },
    }),
  });
  try {
    await fakeVideo(f.media, 'a.mp4');
    const owner = { conversationId: 'same', workflowId: 'flow' };
    const start = await manager.start({ folders: [f.media] }, owner);
    await waiting;
    assert.equal((await manager.start({ folders: [f.media] }, owner)).id, start.id);
    manager.pause(start.id);
    assert.equal(manager.resume(start.id).status, 'queued');
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(manager.status(start.id).status); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.status(start.id).status, 'completed');
    assert.equal(manager.list().length, 1);
  } finally {
    await manager.close();
    await f.close();
  }
});

test('installed FFmpeg reads a generated MP4 and TS through bounded pipes without writing extracted frames', async (t) => {
  const f = await fixture();
  try {
    const { ffmpeg } = findMediaExecutables(f.root);
    if (!ffmpeg) {
      t.skip('No installed FFmpeg; optional local component is not downloaded by tests.');
      return;
    }
    const signal = new AbortController().signal;
    const source = join(f.media, 'synthetic.mp4'),
      transport = join(f.media, 'synthetic.ts');
    await runMediaCommand(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=128x96:rate=5',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        source,
      ],
      signal,
    );
    await runMediaCommand(
      ffmpeg,
      ['-nostdin', '-v', 'error', '-i', source, '-c', 'copy', '-f', 'mpegts', transport],
      signal,
    );
    const decoder = createMediaDecoder(f.root, { ffmpegPath: ffmpeg });
    for (const path of [source, transport]) {
      t.diagnostic(`Synthetic format ${basename(path)}`);
      const metadata = await decoder.probe(path, signal);
      assert.ok(metadata.duration >= 1.5 && metadata.duration <= 3);
      const picture = await decoder.frame(path, 0.4, signal);
      assert.equal(picture.hash.length, 16);
      assert.ok(picture.texture > 10);
    }
    const disguised = join(f.media, 'disguised-playlist.mp4');
    const external = join(f.root, 'outside-media-scope.ts');
    await copyFile(transport, external);
    await writeFile(
      disguised,
      `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${external.replaceAll('\\', '/')}\n#EXT-X-ENDLIST\n`,
    );
    await assert.rejects(decoder.probe(disguised, signal), /unavailable|failed/);
    await assert.rejects(decoder.frame(disguised, 0.4, signal), /failed/);
  } finally {
    await f.close();
  }
});

test('pausing a finished analysis keeps it finished and its evidence intact', async () => {
  const f = await fixture();
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder: mockDecoder() });
  try {
    await writeFile(join(f.media, 'a.jpg'), 'same bytes');
    await copyFile(join(f.media, 'a.jpg'), join(f.media, 'b.jpg'));
    const started = await manager.start({ folders: [f.media] });
    const done = await manager.wait(started.id);
    assert.equal(done.status, 'completed');
    const paused = manager.pause(started.id);
    assert.equal(paused.status, 'completed', 'a late pause does not turn a result back into unfinished work');
    assert.equal(paused.counts.results, done.counts.results);
  } finally {
    await manager.close();
    await f.close();
  }
});

test('only same-size files are hashed, and a resembling video pair is confirmed by a fine check, not by resampling', async () => {
  const f = await fixture();
  const frames = new Map<string, number>();
  // a.mp4 and b.mp4 are different encodings of the same picture; c.mp4 shows something else.
  const decoder = mockDecoder({
    frame: async (path, time) => {
      frames.set(basename(path), (frames.get(basename(path)) ?? 0) + 1);
      return frame(Math.round(time) + (basename(path) === 'c.mp4' ? 500 : 0), time);
    },
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder });
  try {
    await writeFile(join(f.media, 'a.mp4'), 'first encoding');
    await writeFile(join(f.media, 'b.mp4'), 'second encoding, other size');
    await writeFile(join(f.media, 'c.mp4'), 'unrelated video bytes of yet another size');
    await writeFile(join(f.media, 'x.jpg'), 'same bytes');
    await copyFile(join(f.media, 'x.jpg'), join(f.media, 'y.jpg'));
    const result = await manager.wait((await manager.start({ folders: [f.media] })).id);
    assert.equal(result.status, 'completed');
    assert.equal(frames.get('c.mp4'), 6, 'a video like no other stays at the coarse pass');
    // A resembling pair keeps its 6 coarse frames and adds the 8 aligned positions of its fine check.
    assert.equal(frames.get('a.mp4'), 6 + 8);
    assert.equal(frames.get('b.mp4'), 6 + 8);
    const all = manager.status(result.id, { limit: 50 }).results;
    assert.ok(all.some((item) => item.classification === 'exact-bytes' && /x\.jpg|y\.jpg/.test(item.a)));
    assert.ok(all.some((item) => item.classification === 'sampled-full-span'));
    const hashed = (
      (manager as unknown as { db: DatabaseSync }).db
        .prepare('SELECT path, feature FROM files WHERE job=?')
        .all(result.id) as Array<{ path: string; feature: string }>
    ).filter((row) => JSON.parse(row.feature).sha256);
    assert.deepEqual(hashed.map((row) => basename(row.path)).sort(), ['x.jpg', 'y.jpg']);
    assert.ok(result.coverage.some((note) => /未整文件读取哈希/.test(note)));
    // A reader of one evidence page still sees the totals, and that whole duplicates may be recycled on request.
    assert.match(result.summary, /逐字节相同 1 组、全跨度抽样一致 1 组/);
    assert.match(result.summary, /回收须另行确认授权、保留副本及文件未变化/);
    // The plain progress view: every step is listed in order and all are done once the run finishes.
    const steps = manager.status(result.id).steps!;
    assert.deepEqual(
      steps.map((step) => [step.key, step.state]),
      [
        ['scan', 'done'],
        ['hash', 'done'],
        ['coarse', 'done'],
        ['pairs', 'done'],
        ['compare', 'done'],
      ],
    );
    assert.deepEqual([steps[2]!.done, steps[2]!.total], [5, 5]);
    assert.deepEqual([steps[3]!.done, steps[3]!.total], [5, 5]);
    assert.deepEqual([steps[4]!.done, steps[4]!.total], [1, 1], 'only the resembling video pair needs a fine check');
  } finally {
    await manager.close();
    await f.close();
  }
});

test('one similar frame or a different length does not send a video to full sampling', async () => {
  const f = await fixture();
  const frames = new Map<string, number>();
  const durations: Record<string, number> = { 'a.mp4': 23, 'b.mp4': 23, 'long.mp4': 120 };
  // b.mp4 shares only its opening frame with a.mp4 (same room, different video); long.mp4 shows a.mp4's
  // pictures but runs five times as long, so it cannot be a whole duplicate of it.
  const decoder = mockDecoder({
    probe: async (path) => ({ duration: durations[basename(path)]! }),
    frame: async (path, time) => {
      const name = basename(path);
      frames.set(name, (frames.get(name) ?? 0) + 1);
      if (name === 'b.mp4') return frame(time === 0 ? 0 : Math.round(time) + 700, time);
      return frame(Math.round((time / durations[name]!) * 23), time);
    },
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder });
  try {
    await writeFile(join(f.media, 'a.mp4'), 'first');
    await writeFile(join(f.media, 'b.mp4'), 'second video');
    await writeFile(join(f.media, 'long.mp4'), 'a much longer third video');
    const result = await manager.wait((await manager.start({ folders: [f.media] })).id);
    assert.equal(result.status, 'completed');
    for (const name of ['a.mp4', 'b.mp4', 'long.mp4']) assert.equal(frames.get(name), 6, `${name} stays coarse`);
    assert.equal(result.counts.results, 0);
    assert.ok(result.coverage.some((note) => /只查整段重复/.test(note)));
  } finally {
    await manager.close();
    await f.close();
  }
});
