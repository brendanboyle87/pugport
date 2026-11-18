import { track } from './memory-telemetry.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { agreeingMatches, orbFeatures, type Features } from './image-match.ts';
import { readText, releaseOcr } from './ocr.ts';
import { embedTexts, prewarmTexts } from './text-embedding.ts';

/*
 * The heavy picture work runs here, off the server's main thread: the picture model (ONNX Runtime loads and
 * runs it synchronously, seconds at a time) and keypoint matching (OpenCV's WebAssembly calls). On the main
 * thread either would stall every other request while pictures are being analyzed.
 */
type Grey = { data: Uint8Array; width: number; height: number };
type Job =
  | { id: number; type: 'query'; key: string; grey: Grey }
  | { id: number; type: 'match'; key: string; grey: Grey }
  | { id: number; type: 'release'; key: string }
  | { id: number; type: 'embed-images'; modelDir: string; gpuFile?: string; input: Float32Array; count: number }
  | { id: number; type: 'embed-text'; modelDir: string; gpuFile?: string; ids: number[] }
  | { id: number; type: 'provider' }
  | { id: number; type: 'release-pictures' }
  | { id: number; type: 'prewarm-texts'; modelDir: string }
  | { id: number; type: 'ocr'; ocrDir: string; gpuFile?: string; rgb: Uint8Array; width: number; height: number }
  | { id: number; type: 'embed-texts'; modelDir: string; texts: string[] };

const side = 224;
type Tensor = { data: Float32Array };
type Session = {
  run(feeds: Record<string, unknown>, fetches: string[]): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
};
type Ort = {
  InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
};
/** Which device runs the model: a graphics card through DirectML when there is one, otherwise the CPU. */
let provider: 'gpu' | 'cpu' | undefined;
const cpuOptions = () => ({
  executionProviders: ['cpu'],
  intraOpNumThreads: Math.max(2, Math.min(3, Math.floor(availableParallelism() / 4))),
  interOpNumThreads: 1,
});
async function cpuSession(ort: Ort, path: string) {
  provider = 'cpu';
  return ort.InferenceSession.create(path, { ...cpuOptions(), graphOptimizationLevel: 'all' });
}
const benchmarkInput = (ort: Ort, count: number) => ({
  input_ids: new ort.Tensor('int64', BigInt64Array.from([101n, 102n]), [1, 2]),
  attention_mask: new ort.Tensor('int64', BigInt64Array.from([1n, 1n]), [1, 2]),
  pixel_values: new ort.Tensor('float32', new Float32Array(count * 3 * side * side).fill(0.1), [count, 3, side, side]),
});
/**
 * DirectML numbers adapters its own way (on a laptop the integrated chip usually comes first), so the first
 * time each adapter is tried on a small batch and the fastest is remembered in `gpuFile`.
 */
export async function gpuSession(ort: Ort, path: string, gpuFile?: string): Promise<Session | undefined> {
  if (process.platform !== 'win32' || process.env.COMBORUNNER_IMAGE_GPU === '0') return undefined;
  const open = (deviceId: number) =>
    ort.InferenceSession.create(path, {
      executionProviders: [{ name: 'dml', deviceId }, 'cpu'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
  let remembered: { deviceId: number } | undefined;
  try {
    remembered = gpuFile ? (JSON.parse(readFileSync(gpuFile, 'utf8')) as { deviceId: number }) : undefined;
  } catch {
    remembered = undefined;
  }
  if (remembered && Number.isInteger(remembered.deviceId)) {
    const session = await open(remembered.deviceId).catch(() => undefined);
    if (session) return session;
  }
  let best: { deviceId: number; ms: number; session: Session } | undefined;
  for (let deviceId = 0; deviceId < 4; deviceId++) {
    const session = await open(deviceId).catch(() => undefined);
    if (!session) break;
    let previous: Session | undefined;
    try {
      await session.run(benchmarkInput(ort, 4), ['image_embeds']);
      const started = Date.now();
      await session.run(benchmarkInput(ort, 4), ['image_embeds']);
      const ms = Date.now() - started;
      if (!best || ms < best.ms) {
        previous = best?.session;
        best = { deviceId, ms, session };
      }
    } catch {
      /* This adapter cannot run the model. */
    } finally {
      await previous?.release().catch(() => undefined);
      if (best?.session !== session) await session.release().catch(() => undefined);
    }
  }
  if (best && gpuFile) {
    try {
      writeFileSync(gpuFile, JSON.stringify({ deviceId: best.deviceId, msPerBatchOf4: best.ms }));
    } catch {
      /* The chosen session is usable even if its preference cannot be saved. */
    }
  }
  return best?.session;
}

let model: { dir: string; ready: Promise<{ ort: Ort; session: Session }> } | undefined;
function loadModel(dir: string, gpuFile?: string) {
  if (model?.dir !== dir) {
    const previous = model;
    const ready = (async () => {
      const end = track('embedding-model-load');
      try {
        await previous?.ready.then(({ session }) => session.release()).catch(() => undefined);
        const ort = createRequire(import.meta.url)('onnxruntime-node') as Ort;
        const path = join(dir, 'model.onnx');
        const gpu = await gpuSession(ort, path, gpuFile).catch(() => undefined);
        if (gpu) provider = 'gpu';
        const session = gpu ?? (await cpuSession(ort, path));
        return { ort, session };
      } finally {
        end();
      }
    })();
    ready.catch(() => {
      if (model?.ready === ready) model = undefined;
    });
    model = { dir, ready };
  }
  return model.ready;
}

/** The model has one graph for both sides; the unused side gets the smallest valid input. */
async function embedImages(dir: string, input: Float32Array, count: number, gpuFile?: string): Promise<Float32Array> {
  const { ort, session } = await loadModel(dir, gpuFile);
  const result = await session.run(
    {
      input_ids: new ort.Tensor('int64', BigInt64Array.from([101n, 102n]), [1, 2]),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from([1n, 1n]), [1, 2]),
      pixel_values: new ort.Tensor('float32', input, [count, 3, side, side]),
    },
    ['image_embeds'],
  );
  return Float32Array.from(result.image_embeds!.data);
}

async function embedText(dir: string, ids: number[], gpuFile?: string): Promise<Float32Array> {
  const { ort, session } = await loadModel(dir, gpuFile);
  const result = await session.run(
    {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
      pixel_values: new ort.Tensor('float32', new Float32Array(3 * side * side), [1, 3, side, side]),
    },
    ['text_embeds'],
  );
  return Float32Array.from(result.text_embeds!.data);
}

/** The graphics card the picture model chose (see gpuSession), for the other models; none means the CPU. */
function rememberedDevice(gpuFile?: string): number | undefined {
  if (!gpuFile || process.env.COMBORUNNER_IMAGE_GPU === '0') return undefined;
  try {
    return (JSON.parse(readFileSync(gpuFile, 'utf8')) as { deviceId?: number }).deviceId;
  } catch {
    return undefined;
  }
}

const queries = new Map<string, Features>();
/** Dispose picture sessions without unloading a CPU text model hosted in the same worker. */
export async function releasePictureModels(): Promise<void> {
  const end = track('embedding-model-unload');
  const previous = model;
  model = undefined;
  provider = undefined;
  try {
    await Promise.allSettled([previous?.ready.then(({ session }) => session.release()), releaseOcr()]);
  } finally {
    end();
  }
}

async function handle(job: Job) {
  try {
    if (job.type === 'embed-images') {
      const value = await embedImages(job.modelDir, job.input, job.count, job.gpuFile);
      parentPort?.postMessage({ id: job.id, value }, [value.buffer as ArrayBuffer]);
    } else if (job.type === 'embed-text') {
      const value = await embedText(job.modelDir, job.ids, job.gpuFile);
      parentPort?.postMessage({ id: job.id, value }, [value.buffer as ArrayBuffer]);
    } else if (job.type === 'ocr') {
      const lines = await readText(
        job.ocrDir,
        { data: job.rgb, width: job.width, height: job.height },
        rememberedDevice(job.gpuFile),
      );
      parentPort?.postMessage({ id: job.id, value: lines });
    } else if (job.type === 'embed-texts') {
      const value = await embedTexts(job.modelDir, job.texts);
      parentPort?.postMessage({ id: job.id, value }, [value.buffer as ArrayBuffer]);
    } else if (job.type === 'prewarm-texts') {
      await prewarmTexts(job.modelDir);
      parentPort?.postMessage({ id: job.id, value: 0 });
    } else if (job.type === 'release-pictures') {
      await releasePictureModels();
      parentPort?.postMessage({ id: job.id, value: 0 });
    } else if (job.type === 'provider') {
      parentPort?.postMessage({ id: job.id, value: provider ?? '' });
    } else if (job.type === 'query') {
      queries.get(job.key)?.release();
      const features = await orbFeatures(job.grey, 1500);
      queries.set(job.key, features);
      parentPort?.postMessage({ id: job.id, value: features.count });
    } else if (job.type === 'match') {
      const query = queries.get(job.key);
      if (!query) throw new Error('No query picture.');
      const candidate = await orbFeatures(job.grey, 5000);
      try {
        parentPort?.postMessage({ id: job.id, value: await agreeingMatches(query, candidate) });
      } finally {
        candidate.release();
      }
    } else {
      queries.get(job.key)?.release();
      queries.delete(job.key);
      parentPort?.postMessage({ id: job.id, value: 0 });
    }
  } catch (error) {
    parentPort?.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
  }
}
// Cleanup cannot release a session while another message is still running inference with it.
let queue = Promise.resolve();
parentPort?.on('message', (job: Job) => {
  queue = queue.then(() => handle(job));
});
