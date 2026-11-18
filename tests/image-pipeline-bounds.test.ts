import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import v8 from 'node:v8';
import vm from 'node:vm';
import { ImageIndex, decodePictureBatch } from '../src/server/image-search.ts';
import { gpuSession, releasePictureModels } from '../src/server/image-match-worker.ts';
import { readText, releaseOcr } from '../src/server/ocr.ts';
import { memoryTelemetry } from '../src/server/memory-telemetry.ts';
import {
  beginPicturePass,
  modelProvider,
  prewarmTextsInWorker,
  prepareQuery,
  releaseQuery,
  stopMatchWorker,
} from '../src/server/image-match.ts';

// Obtain gc without --expose-gc so the test runs in the normal suite.
if (!global.gc) {
  v8.setFlagsFromString('--expose-gc');
  global.gc = vm.runInNewContext('gc') as typeof global.gc;
}

test('100k vectors share storage and save without a second full vector allocation', async (t) => {
  assert.ok(global.gc, 'Run with --expose-gc');
  const dir = mkdtempSync(join(tmpdir(), 'picture-index-bounds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const count = 100_000,
    bytes = count * 512;
  writeFileSync(join(dir, 'vectors.bin'), new Int8Array(bytes).fill(7));
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      folders: [],
      entries: Array.from({ length: count }, (_, v) => ({
        path: `/synthetic/${v}.png`,
        text: 'synthetic '.repeat(40),
        size: 4096,
        mtime: 1,
        v,
      })),
    }),
  );
  global.gc!();
  global.gc!();
  const beforeLegacy = process.memoryUsage();
  type LegacyEntry = { path: string; text?: string; size: number; mtime: number; vector: Int8Array };
  let legacy: Map<string, LegacyEntry> | undefined = new Map();
  // The former loader kept a copied file buffer, then made one slice allocation per entry.
  const loadLegacy = () => {
    const saved = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
      entries: Array<Omit<LegacyEntry, 'vector'> & { v: number }>;
    };
    const vectors = readFileSync(join(dir, 'vectors.bin')).buffer.slice(0);
    const view = new Int8Array(vectors);
    for (const { v, ...entry } of saved.entries)
      legacy!.set(entry.path.toLowerCase(), { ...entry, vector: view.slice(v * 512, (v + 1) * 512) });
  };
  const measureSave = async (save: () => Promise<void>) => {
    global.gc!();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 1);
    try {
      await save();
    } finally {
      clearInterval(sampler);
    }
    return Math.max(peak, process.memoryUsage().heapUsed) - before;
  };
  loadLegacy();
  const legacyExternal = process.memoryUsage().external - beforeLegacy.external;
  assert.equal(legacy.size, count);
  // Source-only reproduction of ImageIndex.save at HEAD, using the identical loaded synthetic entries.
  const legacySaveHeap = await measureSave(async () => {
    await Promise.resolve();
    const entries: Array<Omit<LegacyEntry, 'vector'> & { v?: number }> = [];
    const vectors: Int8Array[] = [];
    for (const { vector, ...entry } of legacy!.values()) {
      entries.push(vector ? { ...entry, v: vectors.length } : entry);
      if (vector) vectors.push(vector);
    }
    const bytes = new Int8Array(vectors.length * 512);
    vectors.forEach((vector, index) => bytes.set(vector, index * 512));
    const index = join(dir, 'index.json'),
      bin = join(dir, 'vectors.bin');
    await writeFile(`${bin}.tmp`, bytes);
    await writeFile(`${index}.tmp`, JSON.stringify({ version: 1, entries, folders: [] }));
    await rename(`${bin}.tmp`, bin);
    await rename(`${index}.tmp`, index);
  });
  legacy = undefined;
  global.gc!();
  global.gc!();
  const before = process.memoryUsage();
  const index = new ImageIndex(dir);
  const loadedExternal = process.memoryUsage().external - before.external;
  assert.equal(index.entries.size, count);
  const buffers = new Set([...index.entries.values()].map((entry) => entry.vector!.buffer));
  assert.equal(buffers.size, 1);
  assert.ok(loadedExternal < bytes * 2, `external=${loadedExternal}, bytes=${bytes}`);
  index.touch();
  const sharedSaveHeap = await measureSave(() => index.save(true));
  assert.ok(sharedSaveHeap < 100_000_000, `sampled shared save heap delta=${sharedSaveHeap}`);
  assert.equal(readFileSync(join(dir, 'vectors.bin')).length, bytes);
  t.diagnostic(
    JSON.stringify({
      entries: count,
      vectorBytes: bytes,
      legacyLoadExternalBytes: legacyExternal,
      sharedLoadExternalBytes: loadedExternal,
      legacySavePeakHeapDeltaBytes: legacySaveHeap,
      sharedSavePeakHeapDeltaBytes: sharedSaveHeap,
    }),
  );
});

test('shared vector updates and growth preserve binary ordinals and the 2000-touch flush', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'picture-index-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const index = new ImageIndex(dir);
  for (let i = 0; i < 8; i++)
    await index.set({ path: `/synthetic/${i}`, size: 1, mtime: 1, vector: new Int8Array(512).fill(i) });
  await index.set({ path: '/synthetic/2', size: 2, mtime: 2, vector: new Int8Array(512).fill(99) });
  for (let i = 0; i < 1999; i++) index.touch();
  await index.save();
  assert.throws(() => readFileSync(join(dir, 'index.json')));
  index.touch();
  await index.save();
  const restored = new ImageIndex(dir);
  assert.equal(restored.entries.size, 8);
  for (let i = 0; i < 8; i++) assert.equal(restored.entries.get(`/synthetic/${i}`)!.vector![0], i === 2 ? 99 : i);
});

test('eight synthetic image decodes execute sequentially in input order', async () => {
  const calls: string[] = [],
    paths = Array.from({ length: 8 }, (_, i) => `/synthetic/${i}.png`);
  let active = 0,
    peak = 0;
  const results = await decodePictureBatch(
    paths,
    async (path) => {
      calls.push(path);
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return Buffer.alloc(224 * 224 * 3);
    },
    async () => null,
  );
  assert.deepEqual(calls, paths);
  assert.equal(peak, 1);
  assert.equal(results.length, 8);
});

test('invalid saved vector ordinals cannot borrow another entry vector', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'picture-index-ordinals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'vectors.bin'), new Int8Array(1024).fill(5));
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      folders: [],
      entries: [0, 1, -1, 0.5, null, '0', 2].map((v, i) => ({ path: `/synthetic/${i}`, size: 1, mtime: 1, v })),
    }),
  );
  const index = new ImageIndex(dir);
  for (let i = 0; i < 7; i++) assert.equal(!!index.entries.get(`/synthetic/${i}`)!.vector, i < 2);
});

test('concurrent replacement waits for the saved metadata and binary snapshot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'picture-index-concurrent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const index = new ImageIndex(dir);
  await index.set({ path: '/synthetic/one', size: 1, mtime: 1, vector: new Int8Array(512).fill(1) });
  index.touch();
  const saving = index.save(true);
  const replacing = index.set({ path: '/synthetic/one', size: 2, mtime: 2, vector: new Int8Array(512).fill(2) });
  await saving;
  const first = new ImageIndex(dir).entries.get('/synthetic/one')!;
  assert.equal(first.mtime, 1);
  assert.equal(first.vector![0], 1);
  await replacing;
  index.touch();
  await index.save(true);
  const second = new ImageIndex(dir).entries.get('/synthetic/one')!;
  assert.equal(second.mtime, 2);
  assert.equal(second.vector![0], 2);
});

test(
  'adapter scan awaits disposal of failed and losing sessions; batches never exceed four',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const releases = [0, 0, 0, 0],
      batches: number[] = [];
    let clock = 0;
    t.mock.method(Date, 'now', () => clock);
    const sessions = releases.map((_, device) => ({
      async run() {
        clock += [8, 3, 5, 1][device]!;
        if (device === 3) throw new Error('fake adapter failed');
        return { image_embeds: { data: new Float32Array(512) } };
      },
      async release() {
        await new Promise<void>((resolve) => setImmediate(resolve));
        releases[device]++;
      },
    }));
    const ort = {
      InferenceSession: {
        async create(_path: string, options: Record<string, unknown>) {
          return sessions[(options.executionProviders as Array<{ deviceId: number }>)[0]!.deviceId]!;
        },
      },
      Tensor: class {
        constructor(_type: string, _values: unknown, dims: number[]) {
          if (dims.length === 4) batches.push(dims[0]!);
        }
      },
    };
    const best = await gpuSession(ort, '/synthetic/model.onnx');
    assert.equal(best, sessions[1]);
    assert.deepEqual(releases, [1, 0, 1, 1]);
    assert.ok(batches.every((count) => count <= 4));
    await best!.release();
    assert.deepEqual(releases, [1, 1, 1, 1]);
  },
);

test('fake OCR detector and recognizer retain the chosen DirectML device and await both releases', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'picture-ocr-dml-'));
  writeFileSync(join(dir, 'keys.txt'), 'synthetic\n');
  const ort = createRequire(import.meta.url)('onnxruntime-node') as {
    InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<unknown> };
  };
  const opened: Array<{ path: string; providers: unknown }> = [];
  const released: string[] = [];
  t.mock.method(ort.InferenceSession, 'create', async (path: string, options: Record<string, unknown>) => {
    opened.push({ path, providers: options.executionProviders });
    return {
      async run() {
        assert.equal(path, join(dir, 'det.onnx'));
        return { probability: { data: new Float32Array(960 * 960), dims: [1, 1, 960, 960] } };
      },
      async release() {
        await new Promise<void>((resolve) => setImmediate(resolve));
        released.push(path);
      },
    };
  });
  t.after(async () => {
    await releaseOcr();
    rmSync(dir, { recursive: true, force: true });
  });
  const chosenDevice = 2;
  // Only empty synthetic pixels reach OpenCV; ONNX sessions and their inference outputs are fake.
  const lines = await readText(dir, { data: new Uint8Array(32 * 32 * 3), width: 32, height: 32 }, chosenDevice);
  assert.deepEqual(lines, []);
  assert.equal(opened.length, 2);
  for (const openedSession of opened)
    assert.deepEqual(openedSession.providers, [{ name: 'dml', deviceId: chosenDevice }, 'cpu']);
  assert.deepEqual(released, []);
  const beforeUnloads = memoryTelemetry.view().jobs.filter((job) => job.name === 'embedding-model-unload').length;
  await releasePictureModels();
  assert.deepEqual(released.sort(), [join(dir, 'det.onnx'), join(dir, 'rec.onnx')].sort());
  const unloads = memoryTelemetry.view().jobs.filter((job) => job.name === 'embedding-model-unload');
  assert.equal(unloads.length, beforeUnloads + 1);
  for (const field of ['durationMs', 'rssBefore', 'rssAfter', 'rssPeak'] as const)
    assert.ok(Number.isFinite(unloads.at(-1)![field]), field);
  await releaseOcr();
  assert.equal(released.length, 2);
});

test('picture pass cleanup respects other passes, query leases, active CPU jobs and CPU prewarm', async (t) => {
  await stopMatchWorker();
  let terminated = 0;
  const jobs: string[] = [];
  let cpuReply: (() => void) | undefined;
  class FakeWorker extends EventEmitter {
    ref() {}
    unref() {}
    async terminate() {
      terminated++;
      this.emit('exit', 0);
      return 0;
    }
    postMessage(job: { id: number; type: string }) {
      jobs.push(job.type);
      const reply = () => this.emit('message', { id: job.id, value: 0 });
      if (job.type === 'prewarm-texts') cpuReply = reply;
      else setImmediate(reply);
    }
  }
  t.mock.method(workerThreads, 'Worker', function () {
    return new FakeWorker();
  } as unknown as typeof workerThreads.Worker);
  syncBuiltinESMExports();
  t.after(async () => {
    await stopMatchWorker();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const first = beginPicturePass(),
    second = beginPicturePass();
  await prepareQuery('synthetic-lease', { data: new Uint8Array(1), width: 1, height: 1 });
  await first();
  assert.ok(!jobs.includes('release-pictures'));
  await second();
  assert.ok(jobs.includes('release-pictures'));
  assert.equal(terminated, 0);
  await releaseQuery('synthetic-lease');
  await stopMatchWorker();
  assert.equal(terminated, 1);
  const third = beginPicturePass();
  const warming = prewarmTextsInWorker('/synthetic/bge');
  await third();
  assert.equal(terminated, 1, 'pending CPU job keeps worker alive');
  cpuReply!();
  await warming;
  await modelProvider();
  assert.equal(terminated, 1, 'loaded CPU model keeps worker alive after picture cleanup');
});
