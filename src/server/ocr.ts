import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { openCv } from './image-match.ts';

/*
 * Reads the text in a picture (screenshots, photographed documents) with PaddleOCR's PP-OCRv4 models in the
 * ONNX build published by RapidOCR (Apache-2.0): a detector finds the text lines, OpenCV straightens each
 * one, and a recognizer reads it (CTC). Runs in the picture worker thread; nothing leaves the computer.
 */

export function ocrModelDirectory(imageModelDir: string): string | undefined {
  const dir = join(imageModelDir, 'ocr');
  return ['det.onnx', 'rec.onnx', 'keys.txt'].every((name) => existsSync(join(dir, name))) ? dir : undefined;
}

type Tensor = { data: Float32Array; dims: readonly number[] };
type Session = { run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>; release(): Promise<void> };
type Ort = {
  InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
};
let loaded: { dir: string; ready: Promise<{ ort: Ort; det: Session; rec: Session; keys: string[] }> } | undefined;
function load(dir: string, deviceId?: number) {
  if (loaded?.dir !== dir) {
    const previous = loaded;
    const ready = (async () => {
      const old = await previous?.ready.catch(() => undefined);
      if (old) await Promise.allSettled([old.det.release(), old.rec.release()]);
      const ort = createRequire(import.meta.url)('onnxruntime-node') as Ort;
      // On the graphics card the picture model already picked (DirectML), else the CPU.
      const options = {
        executionProviders: deviceId === undefined ? ['cpu'] : [{ name: 'dml', deviceId }, 'cpu'],
        intraOpNumThreads: Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4))),
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      };
      const created = await Promise.allSettled([
        ort.InferenceSession.create(join(dir, 'det.onnx'), options),
        ort.InferenceSession.create(join(dir, 'rec.onnx'), options),
      ]);
      if (created.some((result) => result.status === 'rejected')) {
        await Promise.allSettled(
          created.map((result) => (result.status === 'fulfilled' ? result.value.release() : undefined)),
        );
        throw new Error('OCR model could not load.');
      }
      const [det, rec] = created.map((result) => (result as PromiseFulfilledResult<Session>).value);
      let keys: string[];
      try {
        keys = readFileSync(join(dir, 'keys.txt'), 'utf8').split(/\r?\n/);
      } catch (error) {
        await Promise.allSettled([det!.release(), rec!.release()]);
        throw error;
      }
      if (keys.at(-1) === '') keys.pop();
      return { ort, det: det!, rec: rec!, keys: [...keys, ' '] };
    })();
    ready.catch(() => {
      if (loaded?.ready === ready) loaded = undefined;
    });
    loaded = { dir, ready };
  }
  return loaded.ready;
}

export async function releaseOcr(): Promise<void> {
  const previous = loaded;
  loaded = undefined;
  const model = await previous?.ready.catch(() => undefined);
  if (model) await Promise.allSettled([model.det.release(), model.rec.release()]);
}

type Rgb = { data: Uint8Array; width: number; height: number };
type Point = { x: number; y: number };

/** Lines of text in the picture, top to bottom; empty when there is none worth keeping. */
export async function readText(
  dir: string,
  picture: Rgb,
  deviceId?: number,
  maxLines = 120,
  /** Filled with milliseconds per stage, for diagnosing speed. */
  timings?: Record<string, number>,
): Promise<string[]> {
  const mark = (stage: string, since: number) => {
    if (timings) timings[stage] = (timings[stage] ?? 0) + Date.now() - since;
    return Date.now();
  };
  let at = Date.now();
  const { ort, det, rec, keys } = await load(dir, deviceId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cv = (await openCv()) as any;
  const source = new cv.Mat(picture.height, picture.width, cv.CV_8UC3);
  source.data.set(picture.data);
  const bgr = new cv.Mat();
  cv.cvtColor(source, bgr, cv.COLOR_RGB2BGR);
  source.delete();
  try {
    at = mark('prepare', at);
    const boxes = await detect(cv, ort, det, bgr, timings);
    at = mark('detect', at);
    if (!boxes.length) return [];
    const crops = boxes.slice(0, maxLines).map((box) => straighten(cv, bgr, box));
    at = mark('straighten', at);
    try {
      const lines = await recognize(cv, ort, rec, keys, crops, timings);
      mark('recognize', at);
      return lines;
    } finally {
      for (const crop of crops) crop.delete();
    }
  } finally {
    bgr.delete();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any;

const side = 960;
/** Text-line widths the recognizer is given (height 48); lines are padded up to the nearest. */
const lineWidths = [320, 640, 960, 1440, 1920];
const lineBatch = 16;

async function detect(cv: Cv, ort: Ort, det: Session, bgr: Cv, timings?: Record<string, number>): Promise<Point[][]> {
  const height = bgr.rows,
    width = bgr.cols;
  // Always one input size (the picture scaled into a 960 × 960 canvas): a graphics card compiles the model
  // once per shape, so a fixed shape keeps every later picture fast.
  const h = side,
    w = side;
  const ratio = Math.min(1, side / Math.max(height, width));
  const rh = Math.max(1, Math.round(height * ratio)),
    rw = Math.max(1, Math.round(width * ratio));
  const resized = new cv.Mat();
  cv.resize(bgr, resized, new cv.Size(rw, rh));
  const plane = h * w;
  const input = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225];
  const pixels = resized.data as Uint8Array;
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++)
      for (let c = 0; c < 3; c++)
        input[c * plane + y * w + x] = (pixels[(y * rw + x) * 3 + c]! / 255 - mean[c]!) / std[c]!;
  resized.delete();
  const before = Date.now();
  const output = Object.values(await det.run({ x: new ort.Tensor('float32', input, [1, 3, h, w]) }))[0]!;
  if (timings) timings['detect model'] = (timings['detect model'] ?? 0) + Date.now() - before;
  const probability = output.data;
  const map = new cv.Mat(h, w, cv.CV_32FC1);
  (map.data32F as Float32Array).set(probability);
  const binary = new cv.Mat(h, w, cv.CV_8UC1);
  const bits = binary.data as Uint8Array;
  for (let i = 0; i < plane; i++) bits[i] = probability[i]! > 0.3 ? 255 : 0;
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const boxes: Point[][] = [];
  const scaleX = width / rw,
    scaleY = height / rh;
  try {
    for (let i = 0; i < Math.min(contours.size(), 1000); i++) {
      const contour = contours.get(i);
      const rect = cv.minAreaRect(contour);
      contour.delete();
      if (Math.min(rect.size.width, rect.size.height) < 3) continue;
      const corners = order(cv.RotatedRect.points(rect) as Point[]);
      if (meanInside(cv, map, corners) < 0.5) continue;
      // Grow the box (the detector marks the core of each line): offset by area × 1.6 / perimeter.
      const area = rect.size.width * rect.size.height;
      const perimeter = 2 * (rect.size.width + rect.size.height);
      const grow = (area * 1.6) / perimeter;
      const grown = { ...rect, size: { width: rect.size.width + 2 * grow, height: rect.size.height + 2 * grow } };
      if (Math.min(grown.size.width, grown.size.height) < 5) continue;
      const points = order(cv.RotatedRect.points(grown) as Point[]).map((point) => ({
        x: Math.min(Math.max(point.x * scaleX, 0), width - 1),
        y: Math.min(Math.max(point.y * scaleY, 0), height - 1),
      }));
      boxes.push(points);
    }
  } finally {
    contours.delete();
    hierarchy.delete();
    binary.delete();
    map.delete();
  }
  // Reading order: top to bottom, then left to right within a line.
  boxes.sort((a, b) => (Math.abs(a[0]!.y - b[0]!.y) < 10 ? a[0]!.x - b[0]!.x : a[0]!.y - b[0]!.y));
  return boxes;
}

/** Corners as top-left, top-right, bottom-right, bottom-left. */
function order(points: Point[]): Point[] {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0]!, byDiff[0]!, bySum[3]!, byDiff[3]!];
}

function meanInside(cv: Cv, map: Cv, corners: Point[]): number {
  const xs = corners.map((point) => point.x),
    ys = corners.map((point) => point.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))),
    x1 = Math.min(map.cols - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))),
    y1 = Math.min(map.rows - 1, Math.ceil(Math.max(...ys)));
  if (x1 <= x0 || y1 <= y0) return 0;
  const mask = cv.Mat.zeros(y1 - y0 + 1, x1 - x0 + 1, cv.CV_8UC1);
  const polygon = cv.matFromArray(
    4,
    1,
    cv.CV_32SC2,
    corners.flatMap((point) => [Math.round(point.x - x0), Math.round(point.y - y0)]),
  );
  const polygons = new cv.MatVector();
  polygons.push_back(polygon);
  cv.fillPoly(mask, polygons, new cv.Scalar(1));
  const region = map.roi(new cv.Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1));
  const value = cv.mean(region, mask)[0] as number;
  region.delete();
  polygons.delete();
  polygon.delete();
  mask.delete();
  return value;
}

/** The text line under the box, rotated and stretched upright. */
function straighten(cv: Cv, bgr: Cv, box: Point[]): Cv {
  const [tl, tr, br, bl] = box as [Point, Point, Point, Point];
  const width = Math.round(Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y)));
  const height = Math.round(Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y)));
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
  const transform = cv.getPerspectiveTransform(from, to);
  const crop = new cv.Mat();
  cv.warpPerspective(
    bgr,
    crop,
    transform,
    new cv.Size(Math.max(width, 1), Math.max(height, 1)),
    cv.INTER_CUBIC,
    cv.BORDER_REPLICATE,
  );
  from.delete();
  to.delete();
  transform.delete();
  // A tall, narrow line is vertical text: turn it to read left to right.
  if (crop.rows / Math.max(crop.cols, 1) >= 1.5) {
    const turned = new cv.Mat();
    cv.rotate(crop, turned, cv.ROTATE_90_COUNTERCLOCKWISE);
    crop.delete();
    return turned;
  }
  return crop;
}

async function recognize(
  cv: Cv,
  ort: Ort,
  rec: Session,
  keys: string[],
  crops: Cv[],
  timings?: Record<string, number>,
): Promise<string[]> {
  const lines: string[] = new Array(crops.length).fill('');
  const order = crops.map((crop, index) => ({ index, ratio: crop.cols / Math.max(crop.rows, 1) }));
  order.sort((a, b) => a.ratio - b.ratio);
  const height = 48;
  for (let start = 0; start < order.length; start += lineBatch) {
    const group = order.slice(start, start + lineBatch);
    // Fixed batch size and a few widths, again so the graphics card compiles only a handful of shapes.
    const needed = Math.ceil(height * Math.max(...group.map((item) => item.ratio)));
    const width = lineWidths.find((value) => value >= needed) ?? lineWidths.at(-1)!;
    const plane = height * width;
    const input = new Float32Array(lineBatch * 3 * plane);
    group.forEach(({ index, ratio }, slot) => {
      const w = Math.max(1, Math.min(width, Math.ceil(height * ratio)));
      const resized = new cv.Mat();
      cv.resize(crops[index], resized, new cv.Size(w, height));
      const pixels = resized.data as Uint8Array;
      const base = slot * 3 * plane;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 3; c++)
            input[base + c * plane + y * width + x] = (pixels[(y * w + x) * 3 + c]! / 255 - 0.5) / 0.5;
      resized.delete();
    });
    const before = Date.now();
    const output = Object.values(
      await rec.run({ x: new ort.Tensor('float32', input, [lineBatch, 3, height, width]) }),
    )[0]!;
    if (timings) timings['recognize model'] = (timings['recognize model'] ?? 0) + Date.now() - before;
    const [, steps, classes] = output.dims as [number, number, number];
    group.forEach(({ index }, slot) => {
      let text = '',
        previous = 0,
        confidence = 0,
        count = 0;
      for (let t = 0; t < steps; t++) {
        const offset = (slot * steps + t) * classes;
        let best = 0,
          score = 0;
        for (let k = 0; k < classes; k++) {
          const value = output.data[offset + k]!;
          if (value > score) {
            score = value;
            best = k;
          }
        }
        if (best !== 0 && best !== previous) {
          text += keys[best - 1] ?? '';
          confidence += score;
          count++;
        }
        previous = best;
      }
      if (count && confidence / count >= 0.5) lines[index] = text.trim();
    });
  }
  return lines.filter(Boolean);
}
