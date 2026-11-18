import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import sharp from 'sharp';
import {
  findSimilarImages,
  ignoredImagePath,
  resetImageIndex,
  stopImageBackground,
  scheduleBackground,
} from '../src/server/image-search.ts';
import { runImageSearchWorker, stopImageSearchWorker } from '../src/server/image-search-client.ts';

test('320 synthetic PNG/JPG images index and match off-thread, ignoring development outputs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'image-worker-regression-'));
  const library = join(dir, 'photos');
  mkdirSync(library);
  process.env.COMBORUNNER_IMAGE_INDEX_DIR = join(dir, 'index');
  process.env.COMBORUNNER_IMAGE_BACKGROUND = '0';
  resetImageIndex();
  const rgb = Buffer.alloc(224 * 224 * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (Math.imul(i ^ (i >>> 5), 2654435761) >>> 12) & 255;
  const reference = join(dir, 'reference.png');
  await sharp(rgb, { raw: { width: 224, height: 224, channels: 3 } })
    .png()
    .toFile(reference);
  const jpeg = join(dir, 'reference.jpg');
  await sharp(reference).jpeg({ quality: 95 }).toFile(jpeg);
  for (let i = 0; i < 320; i++) copyFileSync(i % 2 ? reference : jpeg, join(library, `${i}.${i % 2 ? 'png' : 'jpg'}`));
  for (const part of [
    '.claude/worktrees',
    '.oil-ui',
    'artifacts',
    'node_modules',
    'dist',
    '.git',
    'tests/screenshots',
  ]) {
    const output = join(library, part);
    mkdirSync(output, { recursive: true });
    copyFileSync(reference, join(output, 'excluded.png'));
    assert.equal(ignoredImagePath(join(output, 'excluded.png')), true);
  }
  assert.equal(ignoredImagePath(join(library, 'Screenshots', 'personal.png')), false);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const result = await findSimilarImages({ image: reference, folders: [library] }, dir);
    assert.ok(result.includes('160') || result.includes('320'), result);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(delay.max / 1e6 < 200, `main thread max delay ${delay.max / 1e6}ms`);
    const index = JSON.parse(readFileSync(join(dir, 'index', 'index.json'), 'utf8'));
    assert.equal(index.entries.length, 320);
    assert.ok(index.entries.every((entry: { path: string }) => !ignoredImagePath(entry.path)));
    t.diagnostic(JSON.stringify({ pictures: 320, maxEventLoopDelayMs: delay.max / 1e6 }));
  } finally {
    delay.disable();
    stopImageBackground();
    await stopImageSearchWorker();
  }
});

test('worker errors and unresponsive workers reject requests; the next request starts fresh', async (t) => {
  await stopImageSearchWorker();
  const instances: FakeWorker[] = [];
  class FakeWorker extends EventEmitter {
    ref() {}
    unref() {}
    async terminate() {
      return 0;
    }
    postMessage(job: { id: number; job?: unknown }) {
      if (!job.job) return;
      if (instances.length === 1) setImmediate(() => this.emit('error', new Error('synthetic crash')));
      if (instances.length === 3) setImmediate(() => this.emit('message', { id: job.id, status: { analyzed: 0 } }));
    }
  }
  t.mock.method(workerThreads, 'Worker', function () {
    const value = new FakeWorker();
    instances.push(value);
    return value;
  } as unknown as typeof workerThreads.Worker);
  syncBuiltinESMExports();
  t.after(async () => {
    await stopImageSearchWorker();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(runImageSearchWorker({ appRoot: '/synthetic' }), /synthetic crash/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = runImageSearchWorker({ appRoot: '/synthetic' });
  const rejected = assert.rejects(hung, /timed out/);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(30_001);
  await rejected;
  t.mock.timers.reset();
  await runImageSearchWorker({ appRoot: '/synthetic' });
  assert.equal(instances.length, 3);
});

test('background worker failure is contained by the scheduler', async (t) => {
  await stopImageSearchWorker();
  const dir = mkdtempSync(join(tmpdir(), 'image-worker-background-'));
  const model = join(dir, '.runtime', 'image-search');
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, 'model.onnx'), 'synthetic');
  writeFileSync(join(model, 'vocab.txt'), 'synthetic');
  let calls = 0;
  class FailedWorker extends EventEmitter {
    ref() {}
    unref() {}
    async terminate() {
      return 0;
    }
    postMessage(job: { id: number }) {
      calls++;
      setImmediate(() => this.emit('error', new Error('synthetic background failure')));
    }
  }
  t.mock.method(workerThreads, 'Worker', function () {
    return new FailedWorker();
  } as unknown as typeof workerThreads.Worker);
  syncBuiltinESMExports();
  const prior = process.env.COMBORUNNER_IMAGE_BACKGROUND;
  delete process.env.COMBORUNNER_IMAGE_BACKGROUND;
  t.after(async () => {
    stopImageBackground();
    await stopImageSearchWorker();
    if (prior === undefined) delete process.env.COMBORUNNER_IMAGE_BACKGROUND;
    else process.env.COMBORUNNER_IMAGE_BACKGROUND = prior;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  scheduleBackground(dir, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, 1);
});
