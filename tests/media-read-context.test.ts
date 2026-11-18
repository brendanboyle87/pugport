import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaReadContext } from '../src/server/media-read-context.ts';
import type { MediaDecoder } from '../src/server/media-decoder.ts';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('concurrent staged pairs keep physical read routes separate and restore ordinary reads', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-read-context-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const ssdA = join(root, 'a.mp4'),
    ssdB = join(root, 'b.mp4');
  await Promise.all([writeFile(ssdA, 'a'), writeFile(ssdB, 'b')]);
  const seen: string[] = [];
  const signature = { time: 0, hash: '0123456789abcdef', texture: 30, colours: Array(12).fill(0.2) };
  const base: MediaDecoder = {
    description: 'synthetic',
    cacheIdentity: 'synthetic-pipeline-v1',
    image: async () => signature,
    probe: async () => ({ duration: 120 }),
    frame: async (path) => {
      seen.push(path);
      return signature;
    },
  };
  const context = new MediaReadContext();
  const decoder = context.decoder(base);
  const signal = new AbortController().signal;
  // B reads only once A's context is entered, and A reads after B, so both routes are live at once and the
  // order is fixed (a 5 ms timer raced on CI).
  let aIn!: () => void;
  const aEntered = new Promise<void>((resolve) => (aIn = resolve));
  let bRead!: () => void;
  const bDone = new Promise<void>((resolve) => (bRead = resolve));
  await Promise.all([
    context.run(['original-a'], [ssdA], async () => {
      aIn();
      await bDone;
      await decoder.frame('original-a', 0, signal);
      await decoder.frame('original-b', 0, signal);
    }),
    context.run(['original-b'], [ssdB], async () => {
      await aEntered;
      await decoder.frame('original-b', 0, signal);
      await decoder.frame('original-a', 0, signal);
      bRead();
    }),
  ]);
  await decoder.frame('original-a', 0, signal);
  assert.deepEqual(seen, [ssdB, 'original-a', ssdA, 'original-b', 'original-a']);
  assert.equal(decoder.cacheIdentity, base.cacheIdentity);
  await assert.rejects(
    context.run(['original-a'], [ssdA], async () => {
      throw new Error('cancelled');
    }),
  );
  await decoder.frame('original-a', 0, signal);
  assert.equal(seen.at(-1), 'original-a');
});

test('a changed SSD copy never returns a frame that could poison the original-key signature cache', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-read-context-change-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const local = join(root, 'a.mp4');
  await writeFile(local, 'before');
  const context = new MediaReadContext();
  let calls = 0;
  const decoder = context.decoder({
    description: 'synthetic',
    image: async () => {
      throw new Error('unused');
    },
    probe: async () => ({ duration: 120 }),
    frame: async (path, time) => {
      calls++;
      await writeFile(path, 'changed during read');
      return { time, hash: '0123456789abcdef', texture: 30, colours: Array(12).fill(0.2) };
    },
  });
  await assert.rejects(
    context.run(['original'], [local], () => decoder.frame('original', 0, new AbortController().signal)),
    /changed during/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    context.run(['original'], [local], async () => {
      // A different length from the edit above: Windows may keep the same timestamp for two quick writes, and
      // equal size plus equal time would make this change invisible to the test (real media never does this).
      await writeFile(local, 'changed before the read began');
      return decoder.frame('original', 0, new AbortController().signal);
    }),
    /changed before/,
  );
  assert.equal(calls, 1);
});
