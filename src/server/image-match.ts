import { track, watchMemoryWorker, isMemoryTelemetry } from './memory-telemetry.ts';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/*
 * Finds the picture a partial screenshot came from: ORB keypoints in both pictures, nearest-neighbour matches
 * that pass Lowe's ratio test, then a RANSAC homography. Matches that agree on one geometric transform are
 * counted, so a crop that was also scaled still lines up with its source while unrelated pictures do not.
 * OpenCV runs as WebAssembly (@techstark/opencv-js, Apache-2.0); nothing is installed on the system.
 */

type Mat = { rows: number; cols: number; data: Uint8Array; delete(): void };
type KeyPoints = { size(): number; get(index: number): { pt: { x: number; y: number } }; delete(): void };
type Match = { queryIdx: number; trainIdx: number; distance: number };
type Cv = {
  Mat: new (rows?: number, cols?: number, type?: number) => Mat;
  CV_8UC1: number;
  CV_32FC2: number;
  NORM_HAMMING: number;
  RANSAC: number;
  ORB: new (features: number) => { detectAndCompute(m: Mat, mask: Mat, kp: KeyPoints, des: Mat): void; delete(): void };
  KeyPointVector: new () => KeyPoints;
  BFMatcher: new (
    norm: number,
    crossCheck: boolean,
  ) => {
    delete(): void;
    knnMatch(
      a: Mat,
      b: Mat,
      out: { size(): number; get(i: number): { size(): number; get(j: number): Match }; delete(): void },
      k: number,
    ): void;
  };
  DMatchVectorVector: new () => {
    size(): number;
    get(i: number): { size(): number; get(j: number): Match; delete(): void };
    delete(): void;
  };
  matFromArray(rows: number, cols: number, type: number, values: number[]): Mat;
  findHomography(src: Mat, dst: Mat, method: number, threshold: number, mask: Mat): Mat;
  onRuntimeInitialized?: () => void;
  then?: unknown;
};

let opencv: Promise<Cv> | undefined;
export function openCv(): Promise<Cv> {
  opencv ??= new Promise<Cv>((resolve) => {
    const cv = createRequire(import.meta.url)('@techstark/opencv-js') as Cv;
    // The module object is a thenable until the runtime starts; drop that so it can be awaited normally.
    const done = () => {
      delete cv.then;
      resolve(cv);
    };
    if ((cv as { Mat?: unknown }).Mat) done();
    else cv.onRuntimeInitialized = done;
  });
  return opencv;
}

export type Features = { keypoints: KeyPoints; descriptors: Mat; count: number; release(): void };

/** Grey pixels in, ORB features out. */
export async function orbFeatures(grey: { data: Uint8Array; width: number; height: number }, features = 1500) {
  const cv = await openCv();
  const mat = new cv.Mat(grey.height, grey.width, cv.CV_8UC1);
  mat.data.set(grey.data);
  const keypoints = new cv.KeyPointVector(),
    descriptors = new cv.Mat(),
    mask = new cv.Mat();
  const detector = new cv.ORB(features);
  try {
    detector.detectAndCompute(mat, mask, keypoints, descriptors);
  } catch (error) {
    keypoints.delete();
    descriptors.delete();
    throw error;
  } finally {
    detector.delete();
    mat.delete();
    mask.delete();
  }
  return {
    keypoints,
    descriptors,
    count: keypoints.size(),
    release() {
      keypoints.delete();
      descriptors.delete();
    },
  } satisfies Features;
}

/** How many matched keypoints agree on one transform from the query into the candidate. */
export async function agreeingMatches(query: Features, candidate: Features): Promise<number> {
  if (query.descriptors.rows < 8 || candidate.descriptors.rows < 8) return 0;
  const cv = await openCv();
  const pairs = new cv.DMatchVectorVector();
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const from: number[] = [],
    to: number[] = [];
  try {
    matcher.knnMatch(query.descriptors, candidate.descriptors, pairs, 2);
    for (let i = 0; i < pairs.size(); i++) {
      const pair = pairs.get(i);
      try {
        if (pair.size() < 2) continue;
        const best = pair.get(0),
          second = pair.get(1);
        if (best.distance >= 0.75 * second.distance) continue;
        const a = query.keypoints.get(best.queryIdx).pt,
          b = candidate.keypoints.get(best.trainIdx).pt;
        from.push(a.x, a.y);
        to.push(b.x, b.y);
      } finally {
        pair.delete();
      }
    }
  } finally {
    matcher.delete();
    pairs.delete();
  }
  if (from.length / 2 < 8) return 0;
  const src = cv.matFromArray(from.length / 2, 1, cv.CV_32FC2, from),
    dst = cv.matFromArray(to.length / 2, 1, cv.CV_32FC2, to),
    mask = new cv.Mat();
  try {
    cv.findHomography(src, dst, cv.RANSAC, 5, mask).delete();
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inliers++;
    return inliers;
  } finally {
    src.delete();
    dst.delete();
    mask.delete();
  }
}

/** Unrelated pictures reach about 0–12 agreeing matches by chance; a true source usually 40 or more. */
export const sourceThreshold = 20;
export const sureSource = 40;

// ——— The worker that does the matching (image-match-worker.ts) ———

type Pending = {
  timer: NodeJS.Timeout;
  touch: boolean;
  cpuModel: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
let idle: NodeJS.Timeout | undefined;
let stopping: Promise<unknown> | undefined;
const queryLeases = new Set<string>();
let picturePasses = 0;
let pictureFinished = false;
function stopAfterPicture() {
  if (
    pictureFinished &&
    !picturePasses &&
    client &&
    !client.cpuModelLoaded &&
    !client.pending.size &&
    !queryLeases.size
  )
    return stopMatchWorker();
}
/** Holds picture sessions across a pass; unrelated text jobs and query leases keep their worker alive. */
export function beginPicturePass(): () => Promise<void> {
  picturePasses++;
  pictureFinished = false;
  let ended = false;
  return async () => {
    if (ended) return;
    ended = true;
    if (--picturePasses) return;
    if (client) await call({ type: 'release-pictures' }).catch(() => undefined);
    pictureFinished = true;
    await stopAfterPicture();
  };
}
function armIdle() {
  clearTimeout(idle);
  idle = undefined;
  if (!client || client.pending.size || queryLeases.size || picturePasses) return;
  idle = setTimeout(() => {
    idle = undefined;
    if (client && !client.pending.size && !queryLeases.size && !picturePasses) stopMatchWorker();
    else armIdle();
  }, 5 * 60_000).unref();
}
type MatchClient = { worker: Worker; sequence: number; pending: Map<number, Pending>; cpuModelLoaded: boolean };
let client: MatchClient | undefined;

async function call<T = number>(job: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<T> {
  if (stopping) await stopping;
  const touch = job.type !== 'provider';
  if (touch) {
    clearTimeout(idle);
    idle = undefined;
  }
  const end = job.type === 'provider' || job.type === 'release' ? () => {} : track('image-match');
  try {
    if (!client) {
      const source = import.meta.filename.endsWith('.ts');
      const entry = new URL(source ? './image-match-worker.ts' : './image-match-worker.js', import.meta.url).href;
      const worker = new Worker(
        `(async () => {
         const { workerData } = await import('node:worker_threads');
         if (workerData.source) {
           const { tsImport } = await import('tsx/esm/api');
           await tsImport(workerData.entry, workerData.parent);
         } else await import(workerData.entry);
       })().catch(error => { throw error; });`,
        { eval: true, workerData: { source, entry, parent: import.meta.url } },
      );
      watchMemoryWorker(worker);
      const current: MatchClient = (client = {
        worker,
        sequence: 0,
        pending: new Map(),
        cpuModelLoaded: false,
      });
      worker.on('message', (reply: { id: number; value?: unknown; error?: string }) => {
        if (isMemoryTelemetry(reply)) return;
        const pending = current.pending.get(reply.id);
        current.pending.delete(reply.id);
        clearTimeout(pending?.timer);
        if (pending?.cpuModel && reply.error === undefined) current.cpuModelLoaded = true;
        if (!current.pending.size) {
          current.worker.unref();
          if (pending?.touch || !idle) armIdle();
          stopAfterPicture();
        }
        if (reply.error !== undefined) pending?.reject(new Error(reply.error));
        else pending?.resolve(reply.value ?? 0);
      });
      const fail = (error: Error) => {
        for (const pending of current.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        current.pending.clear();
        if (client === current) {
          client = undefined;
          queryLeases.clear();
          clearTimeout(idle);
          idle = undefined;
        }
      };
      worker.on('error', fail);
      worker.on('exit', () => fail(new Error('Matching stopped.')));
    }
    const current = client;
    const id = ++current.sequence;
    // Referenced only while work is waiting on it: an idle worker never keeps the process alive.
    current.worker.ref();
    return await new Promise<T>((resolve, reject) => {
      current.pending.set(id, {
        timer: setTimeout(() => {
          if (client === current) void stopMatchWorker();
        }, 30_000),
        touch,
        cpuModel: job.type === 'embed-texts' || job.type === 'prewarm-texts',
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      current.worker.postMessage({ ...job, id }, transfer);
    });
  } finally {
    end();
  }
}

type Grey = { data: Uint8Array; width: number; height: number };
const send = (grey: Grey) => {
  const data = new Uint8Array(grey.data);
  return { grey: { data, width: grey.width, height: grey.height }, transfer: [data.buffer] };
};

/** Prepares the screenshot's keypoints in the worker; returns how many it found. */
export function prepareQuery(key: string, grey: Grey): Promise<number> {
  const { grey: copy, transfer } = send(grey);
  queryLeases.add(key);
  return call<number>({ type: 'query', key, grey: copy }, transfer).catch((error) => {
    queryLeases.delete(key);
    armIdle();
    throw error;
  });
}

/** Agreeing matches between the prepared screenshot and one candidate picture. */
export function matchQuery(key: string, grey: Grey): Promise<number> {
  const { grey: copy, transfer } = send(grey);
  return call({ type: 'match', key, grey: copy }, transfer);
}

/** Picture embeddings from the model, computed in the worker: `count` rows of normalized pixels in, vectors out. */
export function embedImagesInWorker(
  modelDir: string,
  input: Float32Array,
  count: number,
  gpuFile?: string,
): Promise<Float32Array> {
  return call<Float32Array>({ type: 'embed-images', modelDir, gpuFile, input, count }, [input.buffer as ArrayBuffer]);
}

export function embedTextInWorker(modelDir: string, ids: number[], gpuFile?: string): Promise<Float32Array> {
  return call<Float32Array>({ type: 'embed-text', modelDir, gpuFile, ids });
}

/** The lines of text in a picture (RGB pixels), read in the worker. */
export function readTextInWorker(
  ocrDir: string,
  rgb: { data: Uint8Array; width: number; height: number },
  gpuFile?: string,
): Promise<string[]> {
  const data = new Uint8Array(rgb.data);
  return call<string[]>({ type: 'ocr', ocrDir, gpuFile, rgb: data, width: rgb.width, height: rgb.height }, [
    data.buffer as ArrayBuffer,
  ]);
}

/** Text embeddings (bge-m3) for passages, always on the CPU. */
export function embedTextsInWorker(modelDir: string, texts: string[]): Promise<Float32Array> {
  return call<Float32Array>({ type: 'embed-texts', modelDir, texts });
}

export async function prewarmTextsInWorker(modelDir: string): Promise<void> {
  await call({ type: 'prewarm-texts', modelDir });
}

/** "gpu" or "cpu" once the model has loaded; empty before. */
export function modelProvider(): Promise<string> {
  return client ? call<string>({ type: 'provider' }).catch(() => '') : Promise.resolve('');
}

export function releaseQuery(key: string): Promise<number> {
  return (client ? call<number>({ type: 'release', key }) : Promise.resolve(0))
    .catch(() => 0)
    .finally(() => {
      queryLeases.delete(key);
      armIdle();
      stopAfterPicture();
    });
}

export function stopMatchWorker() {
  clearTimeout(idle);
  const worker = client?.worker;
  client = undefined;
  queryLeases.clear();
  if (worker) {
    const end = track('embedding-model-unload');
    stopping = worker.terminate().finally(() => {
      stopping = undefined;
      end();
    });
  }
  return stopping;
}
