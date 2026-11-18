import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { embedTexts, prewarmTexts } from '../src/server/text-embedding.ts';
import { memoryTelemetry } from '../src/server/memory-telemetry.ts';

test('concurrent prewarm, indexing and question use one CPU-only fake ONNX session', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-text-cpu-'));
  writeFileSync(
    join(directory, 'tokenizer.json'),
    JSON.stringify({
      model: {
        vocab: [
          ['<s>', 0],
          ['<pad>', 0],
          ['</s>', 0],
          ['<unk>', 0],
          ['▁', -1],
        ],
      },
    }),
  );
  const require = createRequire(import.meta.url);
  const path = require.resolve('onnxruntime-node');
  const original = require.cache[path];
  const fake = new Module(path);
  const options: Record<string, unknown>[] = [];
  const shapes: number[][] = [];
  let releases = 0;
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: unknown,
      readonly dims: number[],
    ) {}
  }
  fake.exports = {
    Tensor,
    InferenceSession: {
      async create(_path: string, option: Record<string, unknown>) {
        options.push(option);
        await new Promise<void>((done) => setImmediate(done));
        return {
          async release() {
            releases++;
          },
          async run(feeds: { input_ids: Tensor }) {
            const [rows, length] = feeds.input_ids.dims as [number, number];
            shapes.push([rows, length]);
            const data = new Float32Array(rows * length * 1024);
            for (let row = 0; row < rows; row++) data[row * length * 1024] = 1;
            return { output: { data, dims: [rows, length, 1024] } };
          },
        };
      },
    },
  };
  require.cache[path] = fake;
  t.after(() => {
    if (original) require.cache[path] = original;
    else delete require.cache[path];
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const jobs = () => memoryTelemetry.view().jobs.filter((job) => job.name === 'embedding-model-load').length;
  const before = jobs();
  const [, indexed, question] = await Promise.all([
    prewarmTexts(directory),
    embedTexts(directory, Array(9).fill('synthetic index')),
    embedTexts(directory, ['synthetic question']),
  ]);
  assert.equal(jobs() - before, 1);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0]!.executionProviders, ['cpu']);
  assert.equal(indexed.length, 9 * 1024);
  assert.equal(question[0], 1);
  assert.deepEqual(
    shapes.map(([rows]) => rows),
    [8, 1, 1],
  );
  assert.equal(releases, 0);
  t.diagnostic(
    JSON.stringify({ concurrentRequests: 3, modelLoads: options.length, provider: 'cpu', deviceSwitches: 0 }),
  );
});
