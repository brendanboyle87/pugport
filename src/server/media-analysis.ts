import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { lstat, open, opendir, realpath, statfs } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { hammingDistance } from './image-search.ts';
import { mediaDisplaySteps, type MediaExecution } from './media-analysis-display.ts';
import { mediaPairCheckpointKey } from './media-pair-checkpoint.ts';
import { MediaWorkQueue } from './media-work-queue.ts';
import { withFrameSignatureCache } from './media-frame-cache.ts';
import { MediaReadContext } from './media-read-context.ts';
import { LocalMediaStagingCache } from './media-staging.ts';
import { appDirs } from './platform/dirs.ts';
import { fileIdentity, sameIno } from './platform/file-identity.ts';
import { mediaStagingBudget, mediaStagingPairPriority } from './media-staging-policy.ts';
import {
  MediaPerformanceGovernor,
  type MediaPerformanceOptions,
  type MediaPerformanceSnapshot,
} from './media-performance-governor.ts';
import {
  ProgressEstimateTracker,
  type ProgressEstimate,
  type ProgressRemainingRange,
} from '../shared/progress-estimate.ts';
import { createMediaDecoder, type FrameSignature, type MediaDecoder, type VideoMetadata } from './media-decoder.ts';
const imagePattern = /\.(?:jpe?g|png|webp|gif|tiff?|avif|bmp|heic|heif)$/i;
const videoPattern = /\.(?:mp4|mov|mkv|avi|wmv|flv|webm|m4v|ts|3gp|mts|m2ts)$/i;
const skipped = new Set(['.git', 'node_modules', '$recycle.bin', 'system volume information']);
const maxCandidates = 20_000;
const maxResults = 5_000;
const maxSamples = 24;
/** Positions on the full grid that every video gets; the rest only once it resembles another video. */
const coarseSamples = [0, 5, 9, 14, 18, 23];
/** Files inspected at once. Each decoder runs single-threaded, so a few run side by side. */
const mediaWorkers = Math.max(1, Math.min(7, Math.floor(availableParallelism() / 3)));
const sampleBytes = 1024 * 1024;
type Stamp = { size: number; mtimeMs: number; ctimeMs: number; ino: string | number };
type Feature = {
  /** Absent when no other file shares this size (or head/tail sample): an exact copy is then impossible. */
  sha256?: string;
  image?: FrameSignature;
  video?: VideoMetadata;
  frames?: FrameSignature[];
  planned?: number[];
  errors: string[];
};
type FileRow = {
  id: number;
  path: string;
  kind: 'image' | 'video';
  stamp: string | null;
  feature: string | null;
  error: string | null;
  present: number;
};
export type MediaAnalysisOptions = {
  folders: string[];
  kind?: 'all' | 'images' | 'videos';
  maxFiles?: number;
  engine?: 'auto' | 'gemma' | 'legacy';
  topK?: number;
  videoSampleSeconds?: number;
  recipeId?: string;
  retrievalMode?: 'adaptive' | 'full-index';
  ioConcurrency?: number;
};
export type MediaAnalysisOwner = { conversationId: string; projectPath?: string; workflowId?: string; runId?: string };
type StoredOptions = MediaAnalysisOptions & { folders: string[]; kind: 'all' | 'images' | 'videos'; maxFiles: number };
export type MediaAnalysisStatus = 'queued' | 'running' | 'completed' | 'interrupted' | 'cancelled' | 'failed';
type JobRow = {
  id: string;
  options: string;
  status: MediaAnalysisStatus;
  phase: string;
  progress: string;
  created: string;
  updated: string;
  coverage: string;
  owner: string;
  audit: string;
};
export type MediaAnalysisLimit = {
  code:
    | 'file-limit'
    | 'entry-limit'
    | 'directory-limit'
    | 'unreadable-directory'
    | 'position-limit'
    | 'candidate-limit'
    | 'result-limit'
    | 'model-rerank-limit';
  limit?: number;
  message: string;
};
export type MediaAnalysisScope = {
  status: 'pending' | 'complete' | 'partial';
  fileLimit: number;
  listedFiles: number;
  visitedEntries: number;
  /** Up to twenty affected directories; this is a continuation hint, not permission to expand the scope. */
  remainingDirectories: string[];
  remainingDirectoryCount: number;
};
export type MediaAnalysisExecution = MediaExecution;
/** Saved checkpoint totals are historical records, not proof that this run has revalidated each file. */
export type MediaAnalysisResume = {
  savedFiles: number;
  savedFingerprints: number;
  checkedFiles: number;
  checkingFiles: boolean;
  previousPhase?: string;
};
export type MediaAnalysisRecovery = {
  /** An explicit user/workflow pause always clears this, even if exit interrupts the status write. */
  resumeWanted: boolean;
  reason: 'active' | 'user' | 'workflow' | 'shutdown' | 'crash' | 'failed' | 'completed' | 'closed';
  previousPhase?: string;
};
export type MediaAssistedWorkerInput = {
  workerId: string;
  accountLabel: string;
  runtimeId?: string;
  model?: string;
  effort?: string;
  sessionId?: string;
};
export type MediaAssistedWorkerReport = MediaAssistedWorkerInput & {
  direction: 'back';
  status: 'running' | 'waiting' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  checked: number;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  activePair?: number;
  error?: string;
};
export type MediaAssistanceReport = {
  workers: MediaAssistedWorkerReport[];
  maxWorkers: number;
  baseWorkers: number;
  maxFrameReaders: number;
};
type MediaAnalysisAudit = {
  scope: MediaAnalysisScope;
  limits: MediaAnalysisLimit[];
  execution: MediaAnalysisExecution;
  resume?: MediaAnalysisResume;
  recovery?: MediaAnalysisRecovery;
  assistance?: MediaAssistanceReport;
};
export type MediaEvidence = {
  a: string;
  b: string;
  classification: 'exact-bytes' | 'image-candidate' | 'sampled-full-span' | 'partial-overlap';
  deleteEligible: false;
  explanation: string;
  observedAt: string;
  stamps: [Stamp, Stamp];
  sha256?: string;
  visual?: VisualEvidence;
  imageFineCheck?: { geometricInliers: number };
  reusedFromCheckpoint?: boolean;
  /** Known metadata from the fingerprint bound to this evidence's file stamp; absent fields remain unknown. */
  mediaA?: MediaEvidenceMetadata;
  mediaB?: MediaEvidenceMetadata;
};
export type MediaEvidenceMetadata = { durationSeconds?: number; width?: number; height?: number };
export type VisualEvidence = {
  matches: number;
  samplesA: number;
  samplesB: number;
  offsetSeconds: number;
  /** Fractions of sampled positions that matched; never a fraction of the video's complete content. */
  matchedFractionA: number;
  matchedFractionB: number;
  spanA: [number, number];
  spanB: [number, number];
  positions: Array<{ a: number; b: number; distance: number }>;
  coverage: 'sampled-full-span' | 'partial-overlap';
  /** Full short-video sample plan matched inside the longer video, not proof of complete original content. */
  sampledContainment?: {
    kind: 'sampled-contained';
    contained: 'a' | 'b';
    container: 'a' | 'b';
    containedSpan: [number, number];
    containerSpan: [number, number];
    matchedSamples: number;
    plannedSamples: number;
    unverified: Array<'between-sample-frames' | 'audio' | 'subtitles' | 'quality'>;
  };
  fineCheck?: { planned: number; decoded: number; matches: number; failed: number };
};
export type MediaAnalysisReport = {
  id: string;
  owner: MediaAnalysisOwner | null;
  status: MediaAnalysisStatus;
  phase: string;
  progress: string;
  folders: string[];
  createdAt: string;
  updatedAt: string;
  analysisOnly: true;
  counts: { files: number; fingerprinted: number; errors: number; results: number; sampledContained?: number };
  issues: Array<{ path: string; error: string }>;
  coverage: string[];
  /** Directory enumeration completeness; complete does not mean all possible visual matches were tested. */
  scope: MediaAnalysisScope;
  limits: MediaAnalysisLimit[];
  execution: MediaAnalysisExecution;
  /** Present only for a continued run; checkedFiles tracks its fresh directory inventory. */
  resume?: MediaAnalysisResume;
  /** Separates interrupted active work from a user pause; owner validation belongs to the caller. */
  recovery?: MediaAnalysisRecovery;
  assistance?: MediaAssistanceReport;
  performance?: MediaPerformanceSnapshot;
  summary: string;
  results: MediaEvidence[];
  offset: number;
  nextOffset: number | null;
  /** The run's steps in order, for a plain progress view; absent before this process ran the job. */
  steps?: MediaStep[];
  /** Estimated seconds left in the current step, from its own pace so far. */
  remainingSeconds?: number;
  remainingRange?: ProgressRemainingRange;
  /** An open upper end means later stages are not yet measurable; the lower end is only an estimate. */
  totalRemainingRange?: { minSeconds: number; maxSeconds?: number };
  estimateScope?: 'current-step' | 'whole-task';
  estimateNote?: string;
};

/** Keep lower candidate ranks across every file, rather than letting early files exhaust the queue. */
export class RankedMediaCandidates<T> {
  private readonly ranks: T[][] = [];
  private size = 0;
  pruned = false;
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid media candidate limit.');
  }
  add(rank: number, value: T) {
    const queue = (this.ranks[rank] ??= []);
    queue.push(value);
    this.size++;
    if (this.size > this.limit) {
      for (let at = this.ranks.length - 1; at >= 0; at--) {
        if (!this.ranks[at]?.length) continue;
        this.ranks[at]!.pop();
        this.size--;
        this.pruned = true;
        break;
      }
    }
  }
  get length() {
    return this.size;
  }
  values(): T[] {
    return this.ranks.flat();
  }
}
type StepKey = 'scan' | 'hash' | 'coarse' | 'pairs' | 'compare';
export type MediaStep = {
  key: StepKey;
  label: string;
  state: 'done' | 'running' | 'pending';
  done: number;
  /** Null while the amount is not known yet (files are still being listed). */
  total: number | null;
  note?: string;
} & Partial<ProgressEstimate>;
const stepLabels: Record<StepKey, string> = {
  scan: '列出文件',
  hash: '按大小预筛相同文件',
  coarse: '粗筛：每个文件算指纹（视频抽 6 帧）',
  pairs: '找出可能重复的组合',
  compare: '逐对精核（几组同时进行）',
};

function inside(path: string, root: string) {
  const tail = relative(root, path);
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
}
function samePath(a: string, b: string) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
const now = () => new Date().toISOString();
function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
const featureOf = (row: FileRow): Feature | undefined =>
  row.feature ? (JSON.parse(row.feature) as Feature) : undefined;
const stampOf = (row: FileRow): Stamp => JSON.parse(row.stamp!) as Stamp;
function knownMediaMetadata(row: FileRow): MediaEvidenceMetadata | undefined {
  const video = featureOf(row)?.video;
  if (!video) return;
  const metadata: MediaEvidenceMetadata = {};
  for (const [key, value] of [
    ['durationSeconds', video.duration],
    ['width', video.width],
    ['height', video.height],
  ] as const)
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) metadata[key] = value;
  return Object.keys(metadata).length ? metadata : undefined;
}
function equalStamp(a: Stamp, b: Stamp) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && sameIno(a.ino, b.ino);
}

async function fileStamp(path: string, roots: string[]): Promise<Stamp> {
  if (!roots.some((root) => inside(path, root))) throw new Error('Media file is outside the explicit analysis scope.');
  const info = await lstat(path);
  const identity = fileIdentity(await lstat(path, { bigint: true }));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Only regular media files are analysed.');
  const actual = await realpath(path);
  if (!samePath(actual, path) || !roots.some((root) => inside(actual, root)))
    throw new Error('Media path changed or crosses a symlink/junction.');
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: String(identity.ino) };
}

async function contentHash(path: string, signal: AbortSignal) {
  const hash = createHash('sha256');
  // Stream the entire file with bounded memory; timeout leaves this file pending for a later attempt.
  const timeout = AbortSignal.timeout(180_000);
  const reader = createReadStream(path, { highWaterMark: 256 * 1024, signal: AbortSignal.any([signal, timeout]) });
  for await (const chunk of reader) hash.update(chunk as Buffer);
  signal.throwIfAborted();
  return hash.digest('hex');
}

/** The file's size with its first and last MiB: cheap, and equal for every pair of identical files. */
async function sampleHash(path: string, size: number) {
  const hash = createHash('sha256').update(String(size));
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(sampleBytes, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > sampleBytes) {
      const tail = Buffer.alloc(Math.min(sampleBytes, size - head.length));
      await handle.read(tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Whether two videos could be the same footage end to end (renamed, re-encoded, resized). Their lengths must
 * agree; a clip taken from the middle of a longer video is a partial overlap, never recycled, and not searched
 * library-wide because its cost is out of all proportion to its use.
 */
function sameLength(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(2, 0.03 * Math.max(a, b));
}

/** The frames at the coarse positions of a video's own grid (present in both coarse and full features). */
function coarseFrames(feature: Feature): Array<FrameSignature | undefined> {
  if (!feature.video || !feature.frames) return [];
  const grid = samplingTimes(feature.video.duration);
  return coarseSamples.map((index) => feature.frames!.find((frame) => frame.time === grid[index]));
}

export function samplingTimes(duration: number, count = maxSamples): number[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid video duration.');
  count = Math.max(4, Math.min(maxSamples, Math.floor(count)));
  const end = Math.max(0, duration - Math.min(0.1, duration / 100));
  return Array.from({ length: count }, (_, index) => Number(((end * index) / (count - 1)).toFixed(4)));
}

function distance(a: FrameSignature, b: FrameSignature): number | undefined {
  // Flat black/title frames cannot establish a duplicate or an overlapping clip.
  if (a.texture < 10 || b.texture < 10) return undefined;
  const bits = hammingDistance(a.hash, b.hash);
  const colour = a.colours.reduce((sum, value, i) => sum + Math.abs(value - (b.colours[i] ?? 0)), 0) / 6;
  return bits <= 8 && colour <= 0.16 ? bits : undefined;
}

function sampledContainment(
  visual: VisualEvidence,
  durationA: number,
  durationB: number,
): VisualEvidence['sampledContainment'] {
  if (
    !Number.isFinite(durationA) ||
    !Number.isFinite(durationB) ||
    durationA <= 0 ||
    durationB <= 0 ||
    Math.abs(durationA - durationB) <= 0.2 ||
    visual.fineCheck?.failed ||
    visual.positions.length !== visual.matches
  )
    return;
  const contained = durationA < durationB ? 'a' : 'b';
  const container = contained === 'a' ? 'b' : 'a';
  const duration = contained === 'a' ? durationA : durationB;
  const containerDuration = container === 'a' ? durationA : durationB;
  const containedSpan = contained === 'a' ? visual.spanA : visual.spanB;
  const containerSpan = container === 'a' ? visual.spanA : visual.spanB;
  const plannedSamples = contained === 'a' ? visual.samplesA : visual.samplesB;
  // Overlap-only grids may be 12/12 while omitting the beginning/end of the short video.
  // Use the decoder's endpoint allowance, never the longer video's coarse sample spacing.
  if (
    plannedSamples < 4 ||
    visual.matches !== plannedSamples ||
    containedSpan[0] > 0.1001 ||
    containedSpan[0] < -0.0001 ||
    duration - containedSpan[1] > 0.1001 ||
    containedSpan[1] > duration + 0.0001 ||
    visual.positions.some((position) => Math.abs(position.b - position.a - visual.offsetSeconds) > 0.2)
  )
    return;
  const mappedStart = contained === 'a' ? visual.offsetSeconds : -visual.offsetSeconds;
  if (mappedStart < -0.0001 || mappedStart + duration > containerDuration + 0.0001) return;
  if (
    visual.fineCheck &&
    (visual.fineCheck.planned < 4 ||
      visual.fineCheck.decoded !== visual.fineCheck.planned ||
      visual.fineCheck.matches !== visual.fineCheck.planned)
  )
    return;
  return {
    kind: 'sampled-contained',
    contained,
    container,
    containedSpan,
    containerSpan,
    matchedSamples: visual.matches,
    plannedSamples,
    unverified: ['between-sample-frames', 'audio', 'subtitles', 'quality'],
  };
}

function videoExplanation(visual: VisualEvidence) {
  if (visual.sampledContainment) {
    const item = visual.sampledContainment;
    return `短片 ${item.contained.toUpperCase()} 的首尾和中间 ${item.matchedSamples}/${item.plannedSamples} 个抽样位置在长片 ${item.container.toUpperCase()} 内一致；仅证明整段抽样包含，未核对抽样之间逐帧、音轨、字幕或画质，不能据此回收。`;
  }
  return visual.coverage === 'sampled-full-span'
    ? '固定程序确认首尾和中间抽样一致；未逐帧比对或核对音轨字幕，不能直接回收。'
    : '程序定位到若干画面重叠；未证明短片整段抽样被覆盖或画质不差，保留两份。';
}

/** Ordered, one-to-one matching under a constant offset. Repeated static frames are not evidence. */
export function compareVideoSamples(
  a: FrameSignature[],
  b: FrameSignature[],
  durationA: number,
  durationB: number,
): VisualEvidence | undefined {
  if (a.length < 4 || b.length < 4) return;
  if (new Set(a.map((item) => item.hash)).size < 3 || new Set(b.map((item) => item.hash)).size < 3) return;
  const step = Math.max(durationA / (maxSamples - 1), durationB / (maxSamples - 1), 0.05);
  const candidates = a.flatMap((left) =>
    b.flatMap((right) => {
      const bits = distance(left, right);
      return bits === undefined ? [] : [{ a: left.time, b: right.time, distance: bits, hash: left.hash }];
    }),
  );
  let best: typeof candidates = [];
  const offsetsTried = new Set<number>();
  for (const anchor of candidates) {
    const offset = anchor.b - anchor.a;
    const bucket = Math.round(offset / (step * 0.3));
    if (offsetsTried.has(bucket)) continue;
    offsetsTried.add(bucket);
    const available = candidates
      .filter((pair) => Math.abs(pair.b - pair.a - offset) <= step * 0.6)
      .sort((left, right) => left.a - right.a || left.distance - right.distance);
    const chosen: typeof candidates = [];
    let lastA = -1,
      lastB = -1;
    for (const pair of available)
      if (pair.a > lastA && pair.b > lastB) {
        chosen.push(pair);
        lastA = pair.a;
        lastB = pair.b;
      }
    if (chosen.length > best.length) best = chosen;
  }
  if (best.length < 4 || new Set(best.map((pair) => pair.hash)).size < 3) return;
  const first = best[0]!,
    last = best.at(-1)!;
  // Several positions, spread through time, are required; no fixed "five seconds means duplicate" rule.
  if (last.a - first.a < step * 2 || last.b - first.b < step * 2) return;
  const full =
    best.length === a.length &&
    best.length === b.length &&
    first.a <= step &&
    first.b <= step &&
    durationA - last.a <= step &&
    durationB - last.b <= step &&
    Math.abs(durationA - durationB) <= step;
  const offsets = best.map((pair) => pair.b - pair.a).sort((x, y) => x - y);
  const visual: VisualEvidence = {
    matches: best.length,
    samplesA: a.length,
    samplesB: b.length,
    offsetSeconds: offsets[Math.floor(offsets.length / 2)]!,
    matchedFractionA: best.length / a.length,
    matchedFractionB: best.length / b.length,
    spanA: [first.a, last.a],
    spanB: [first.b, last.b],
    positions: best.map(({ a, b, distance }) => ({ a, b, distance })),
    coverage: full ? 'sampled-full-span' : 'partial-overlap',
  };
  const containment = sampledContainment(visual, durationA, durationB);
  if (containment) visual.sampledContainment = containment;
  return visual;
}

/** Local background work owns its checkpoint, independently of any model run or quota. */
export class MediaAnalysisManager {
  private readonly db: DatabaseSync;
  private readonly decoder: MediaDecoder;
  private readonly readContext = new MediaReadContext();
  private readonly stagingOptions?: { cacheRoot: string; maxBytes?: number; minFreeBytes?: number };
  private readonly automaticStagingBudget: boolean;
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private tail = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly onUpdate?: (report: MediaAnalysisReport) => void;
  private readonly lastUpdate = new Map<string, number>();
  private readonly clock: () => number;
  private readonly performanceOptions: MediaPerformanceOptions;
  /** Timing lives in memory; progress updates add bounded samples without additional SQLite writes. */
  private readonly steps = new Map<string, { list: MediaStep[]; tracker: ProgressEstimateTracker }>();
  private readonly comparisons = new Map<
    string,
    {
      attach(input: MediaAssistedWorkerInput): MediaAssistedWorkerReport;
      stop(workerId: string): MediaAssistedWorkerReport;
      snapshot(): MediaAssistanceReport;
      performance(): MediaPerformanceSnapshot;
    }
  >();

  /** Moves the job to a step (earlier steps count as done) and records its progress. */
  private step(id: string, key: StepKey, done: number, total: number | null, note?: string) {
    let entry = this.steps.get(id);
    if (!entry) {
      entry = {
        list: (Object.keys(stepLabels) as StepKey[]).map((step) => ({
          key: step,
          label: stepLabels[step],
          state: 'pending' as const,
          done: 0,
          total: null,
        })),
        tracker: new ProgressEstimateTracker(),
      };
      this.steps.set(id, entry);
    }
    const at = entry.list.findIndex((step) => step.key === key);
    entry.tracker.observe(key, done, total, this.clock());
    entry.list.forEach((step, index) => {
      if (index < at && step.state !== 'done') step.state = 'done';
      if (index > at) step.state = 'pending';
    });
    Object.assign(entry.list[at]!, { state: 'running', done, total, ...(note ? { note } : {}) });
  }
  private finishSteps(id: string) {
    this.steps.get(id)?.tracker.finish(this.clock());
    for (const step of this.steps.get(id)?.list ?? []) step.state = 'done';
  }
  private timing(
    id: string,
    status: MediaAnalysisStatus,
  ): Pick<
    MediaAnalysisReport,
    'steps' | 'remainingSeconds' | 'remainingRange' | 'totalRemainingRange' | 'estimateScope' | 'estimateNote'
  > {
    const entry = this.steps.get(id);
    if (!entry) return {};
    const steps = entry.list.map((step) => ({
      ...step,
      ...entry.tracker.estimate(step.key, this.clock()),
      ...(step.state === 'done'
        ? { estimateState: 'done' as const, remainingSeconds: undefined, remainingRange: undefined }
        : {}),
    }));
    const current = steps.find((step) => step.state === 'running');
    if (status !== 'running' || !current) return { steps };
    const wholeTask = current.key === 'compare';
    return {
      steps,
      remainingSeconds: current.remainingSeconds,
      remainingRange: current.remainingRange,
      ...(current.remainingRange
        ? {
            totalRemainingRange: {
              minSeconds: current.remainingRange.minSeconds,
              ...(wholeTask ? { maxSeconds: current.remainingRange.maxSeconds } : {}),
            },
          }
        : {}),
      estimateScope: wholeTask ? 'whole-task' : 'current-step',
      estimateNote:
        [current.estimateNote, wholeTask ? '' : '后续步骤尚未开始，暂无法估算全程。'].filter(Boolean).join(' · ') ||
        undefined,
    };
  }

  constructor(
    dataDir: string,
    options: {
      appRoot?: string;
      ffmpegPath?: string;
      ffprobePath?: string;
      decoder?: MediaDecoder;
      staging?: false | { cacheRoot?: string; maxBytes?: number; minFreeBytes?: number };
      onUpdate?: (report: MediaAnalysisReport) => void;
      now?: () => number;
      performance?: MediaPerformanceOptions;
    } = {},
  ) {
    const directory = join(dataDir, 'media-analysis');
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'checkpoint.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, options TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL,
        progress TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, coverage TEXT NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, job TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
        stamp TEXT, feature TEXT, error TEXT, present INTEGER NOT NULL DEFAULT 1, UNIQUE(job,path));
      CREATE INDEX IF NOT EXISTS files_job ON files(job);
      CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY, job TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(job,a,b));
      CREATE INDEX IF NOT EXISTS evidence_job ON evidence(job);
      CREATE TABLE IF NOT EXISTS pair_cache(job TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL,
        key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,a,b));
      CREATE TABLE IF NOT EXISTS pair_checks(job TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL,
        key TEXT NOT NULL, checked TEXT NOT NULL, PRIMARY KEY(job,a,b));`);
    if (
      !(this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).some((row) => row.name === 'audit')
    )
      this.db.exec("ALTER TABLE jobs ADD COLUMN audit TEXT NOT NULL DEFAULT '{}'");
    // Only work that was active at exit is eligible. Legacy explicit pauses have a different exact message.
    const legacyShutdown = '应用关闭，分析进度已保留。';
    const legacyCrash = '应用退出时分析尚未完成；可从本地记录续跑。';
    // A crash just after an explicit pause can leave helper metadata running even though the parent
    // must stay paused. Reconcile helper status separately from parent recovery eligibility.
    const assistedJobs = this.db
      .prepare("SELECT id FROM jobs WHERE json_extract(audit,'$.assistance') IS NOT NULL")
      .all() as Array<{ id: string }>;
    for (const job of assistedJobs) {
      const audit = this.audit(job.id);
      let changed = false;
      for (const worker of audit.assistance?.workers ?? []) {
        if (worker.status === 'running' || worker.status === 'waiting') {
          worker.status = 'interrupted';
          worker.updatedAt = now();
          delete worker.activePair;
          changed = true;
        }
      }
      if (changed) this.saveAudit(job.id, audit);
    }
    const stale = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN ('running','queued') OR
      (status='interrupted' AND json_extract(audit,'$.recovery') IS NULL AND progress IN
        (?,?))`,
      )
      .all(legacyShutdown, legacyCrash) as JobRow[];
    for (const job of stale) {
      const audit = this.audit(job.id);
      if (audit.recovery?.resumeWanted !== false) {
        const phase = job.phase === 'paused' ? audit.resume?.previousPhase : job.phase;
        audit.recovery = {
          resumeWanted: true,
          reason: job.progress === legacyShutdown ? 'shutdown' : 'crash',
          ...(phase ? { previousPhase: phase } : {}),
        };
        this.saveAudit(job.id, audit);
      }
      this.db
        .prepare('UPDATE jobs SET status=?,phase=?,progress=?,updated=? WHERE id=?')
        .run(
          'interrupted',
          'paused',
          audit.recovery?.resumeWanted === false
            ? '应用退出前已停止分析，现有记录保留。'
            : '应用退出时分析尚未完成；已保存记录，等待恢复。',
          now(),
          job.id,
        );
    }
    this.decoder = withFrameSignatureCache(
      this.readContext.decoder(options.decoder ?? createMediaDecoder(options.appRoot ?? process.cwd(), options)),
      this.db,
      (path) => this.readContext.expectedOriginalIdentity(path),
    );
    this.automaticStagingBudget = !options.decoder;
    if (options.staging !== false && (!options.decoder || options.staging)) {
      const staging = options.staging || {};
      const cache = appDirs().cache;
      this.stagingOptions = {
        ...staging,
        cacheRoot: resolve(
          staging.cacheRoot ?? (cache ? join(cache, 'media-verification') : join(dataDir, 'media-analysis', 'staging')),
        ),
      };
    }
    this.onUpdate = options.onUpdate;
    this.clock = options.now ?? Date.now;
    this.performanceOptions = { enabled: options.performance?.enabled ?? !options.decoder, ...options.performance };
  }

  async start(input: MediaAnalysisOptions, owner: MediaAnalysisOwner | null = null): Promise<MediaAnalysisReport> {
    if (this.closing) throw new Error('Media analysis is closing.');
    if (!Array.isArray(input.folders) || input.folders.length < 1 || input.folders.length > 20)
      throw new Error('Specify 1–20 media folders.');
    const folders: string[] = [];
    for (const folder of input.folders) {
      if (typeof folder !== 'string' || !isAbsolute(folder)) throw new Error('Media folders must be absolute paths.');
      const path = await realpath(resolve(folder));
      if (!(await lstat(path)).isDirectory()) throw new Error('Media scope must name existing folders.');
      if (!folders.some((root) => inside(path, root))) {
        for (let i = folders.length - 1; i >= 0; i--) if (inside(folders[i]!, path)) folders.splice(i, 1);
        folders.push(path);
      }
    }
    if (input.kind && !['all', 'images', 'videos'].includes(input.kind)) throw new Error('Invalid media kind.');
    if (input.engine !== undefined && !['auto', 'gemma', 'legacy'].includes(input.engine))
      throw new Error('Invalid media engine.');
    if (input.retrievalMode !== undefined && !['adaptive', 'full-index'].includes(input.retrievalMode))
      throw new Error('Invalid media retrieval mode.');
    if (
      input.ioConcurrency !== undefined &&
      (!Number.isInteger(input.ioConcurrency) || input.ioConcurrency < 1 || input.ioConcurrency > 8)
    )
      throw new Error('Media I/O concurrency must be an integer from 1 to 8.');
    if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 20))
      throw new Error('Media topK must be an integer from 1 to 20.');
    if (
      input.videoSampleSeconds !== undefined &&
      (!Number.isFinite(input.videoSampleSeconds) || input.videoSampleSeconds < 5 || input.videoSampleSeconds > 120)
    )
      throw new Error('Media videoSampleSeconds must be from 5 to 120.');
    if (input.recipeId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(input.recipeId))
      throw new Error('Invalid media recipe ID.');
    const options: StoredOptions = {
      folders,
      kind: input.kind ?? 'all',
      maxFiles: Math.min(20_000, Math.max(1, Math.floor(input.maxFiles ?? 10_000))),
      engine: input.engine ?? 'auto',
      topK: input.topK ?? 8,
      videoSampleSeconds: input.videoSampleSeconds ?? 30,
      retrievalMode: input.retrievalMode ?? 'full-index',
      ...(input.ioConcurrency !== undefined ? { ioConcurrency: input.ioConcurrency } : {}),
      ...(input.recipeId ? { recipeId: input.recipeId } : {}),
    };
    if (!Number.isFinite(options.maxFiles)) throw new Error('Invalid media file limit.');
    options.folders.sort();
    if (owner?.workflowId) {
      const active = this.db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('queued','running') AND json_extract(owner,'$.workflowId')=? AND json_extract(owner,'$.conversationId')=?",
        )
        .all(owner.workflowId, owner.conversationId) as JobRow[];
      const existing = active.find((job) => JSON.stringify(JSON.parse(job.options)) === JSON.stringify(options));
      if (existing) return this.status(existing.id);
    }
    const id = randomUUID(),
      time = now();
    this.db
      .prepare(
        'INSERT INTO jobs(id,options,status,phase,progress,created,updated,coverage,owner,audit) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        JSON.stringify(options),
        'queued',
        'scanning',
        '等待本地分析。',
        time,
        time,
        '[]',
        JSON.stringify(owner),
        JSON.stringify(this.emptyAudit(options)),
      );
    this.launch(id);
    return this.status(id);
  }

  status(id: string, page: { offset?: number; limit?: number } = {}): MediaAnalysisReport {
    const job = this.job(id);
    const options = JSON.parse(job.options) as StoredOptions;
    const offset = Math.max(0, Math.floor(page.offset ?? 0)),
      limit = Math.min(50, Math.max(0, Math.floor(page.limit ?? 20)));
    if (!Number.isFinite(offset) || !Number.isFinite(limit)) throw new Error('Invalid evidence page.');
    const count = this.db
      .prepare(
        `SELECT COUNT(*) AS files, SUM(CASE WHEN feature IS NOT NULL THEN 1 ELSE 0 END) AS fingerprinted,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM files WHERE job=? AND present=1`,
      )
      .get(id) as { files: number; fingerprinted: number | null; errors: number | null };
    const results = (this.db.prepare('SELECT COUNT(*) AS count FROM evidence WHERE job=?').get(id) as { count: number })
      .count;
    const sampledContained = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM evidence WHERE job=? AND json_extract(data,'$.visual.sampledContainment.kind')='sampled-contained'",
        )
        .get(id) as { count: number }
    ).count;
    // Totals per kind, so a reader of one page still knows how many whole duplicates there are.
    const kinds = Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT json_extract(data,'$.classification') AS kind, COUNT(*) AS count FROM evidence WHERE job=? GROUP BY kind",
          )
          .all(id) as Array<{ kind: string; count: number }>
      ).map((row) => [row.kind, row.count]),
    );
    const breakdown = results
      ? `（逐字节相同 ${kinds['exact-bytes'] ?? 0} 组、全跨度抽样一致 ${kinds['sampled-full-span'] ?? 0} 组、短片整段抽样匹配 ${sampledContained} 组、局部重叠 ${Math.max(0, (kinds['partial-overlap'] ?? 0) - sampledContained)} 组、相似图片 ${kinds['image-candidate'] ?? 0} 组）`
      : '';
    const audit = this.audit(id);
    // Enumeration temporarily clears present before verifying membership again. Keep the saved totals visible
    // during that check, and expose its separate checkedFiles count rather than pretending it is complete.
    const files = audit.resume?.checkingFiles ? Math.max(count.files, audit.resume.savedFiles) : count.files;
    const fingerprinted = audit.resume?.checkingFiles
      ? Math.max(count.fingerprinted ?? 0, audit.resume.savedFingerprints)
      : (count.fingerprinted ?? 0);
    const checkpointSummary = audit.resume?.checkingFiles
      ? `已保存 ${audit.resume.savedFingerprints} 份指纹记录；本次已核对清单中的 ${audit.resume.checkedFiles} 个媒体文件，保存记录仍需核对文件是否变化。`
      : `已读取 ${fingerprinted}/${files} 个文件。`;
    const scopeSummary =
      audit.scope.status === 'partial'
        ? `本批目录未覆盖完整范围：已列出 ${audit.scope.listedFiles} 个媒体文件；${audit.limits
            .filter((item) =>
              ['file-limit', 'entry-limit', 'directory-limit', 'unreadable-directory'].includes(item.code),
            )
            .map((item) => item.message)
            .join(' ')} 不得称为全盘完成。`
        : audit.scope.status === 'complete'
          ? '所选目录枚举完成；视觉候选并非两两穷举。'
          : '目录范围尚未枚举完成。';
    const budgetSummary = audit.limits
      .filter((item) => ['position-limit', 'candidate-limit', 'result-limit', 'model-rerank-limit'].includes(item.code))
      .map((item) => item.message)
      .join(' ');
    const timing = this.timing(id, job.status);
    return {
      id,
      owner: JSON.parse(job.owner) as MediaAnalysisOwner | null,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      folders: options.folders,
      createdAt: job.created,
      updatedAt: job.updated,
      analysisOnly: true,
      counts: { files, fingerprinted, errors: count.errors ?? 0, results, sampledContained },
      issues: this.db
        .prepare('SELECT path,error FROM files WHERE job=? AND present=1 AND error IS NOT NULL ORDER BY id LIMIT 20')
        .all(id) as Array<{ path: string; error: string }>,
      coverage: JSON.parse(job.coverage) as string[],
      ...audit,
      ...(this.comparisons.has(id) ? { assistance: this.comparisons.get(id)!.snapshot() } : {}),
      ...(this.comparisons.has(id) ? { performance: this.comparisons.get(id)!.performance() } : {}),
      summary: `${scopeSummary} ${budgetSummary} ${job.progress} ${checkpointSummary} ${results} 组证据${breakdown}。分析不移动或删除文件。视觉抽样与语义近似不能证明逐帧或音轨完全相同，也不能直接授权回收；回收须另行确认授权、保留副本及文件未变化。`,
      results: (
        this.db
          .prepare(
            `SELECT evidence.data, a.stamp AS stampA, a.feature AS featureA, b.stamp AS stampB, b.feature AS featureB
            FROM evidence LEFT JOIN files a ON a.job=evidence.job AND a.id=evidence.a
            LEFT JOIN files b ON b.job=evidence.job AND b.id=evidence.b
            WHERE evidence.job=? ORDER BY evidence.id LIMIT ? OFFSET ?`,
          )
          .all(id, limit, offset) as Array<{
          data: string;
          stampA: string | null;
          featureA: string | null;
          stampB: string | null;
          featureB: string | null;
        }>
      ).map((row) => {
        const evidence = JSON.parse(row.data) as MediaEvidence;
        for (const [key, stamp, feature, original] of [
          ['mediaA', row.stampA, row.featureA, evidence.stamps[0]],
          ['mediaB', row.stampB, row.featureB, evidence.stamps[1]],
        ] as const) {
          if (!evidence[key] && stamp && equalStamp(JSON.parse(stamp) as Stamp, original))
            evidence[key] = knownMediaMetadata({ feature } as FileRow);
        }
        return evidence;
      }),
      offset,
      nextOffset: offset + limit < results ? offset + limit : null,
      ...timing,
      ...(timing.steps ? { steps: mediaDisplaySteps(timing.steps, audit.execution, audit.resume) } : {}),
    };
  }

  /** The caller checks conversation/account ownership; this manager checks live job and capacity. */
  attachAssistedWorker(id: string, input: MediaAssistedWorkerInput): MediaAssistedWorkerReport {
    const job = this.job(id);
    if (!/^[\da-f-]{36}$/i.test(input.workerId) || !input.accountLabel.trim() || input.accountLabel.length > 120)
      throw new Error('Invalid media assisted worker identity.');
    for (const key of ['runtimeId', 'model', 'effort', 'sessionId'] as const) {
      if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key]!.length > 200))
        throw new Error('Invalid media assisted worker metadata.');
    }
    const session = this.comparisons.get(id);
    if (this.closing || job.status !== 'running' || job.phase !== 'comparing' || !session)
      throw new Error('Media comparison is not ready for assisted workers.');
    return session.attach(input);
  }

  stopAssistedWorker(id: string, workerId: string): MediaAssistedWorkerReport {
    this.job(id);
    const session = this.comparisons.get(id);
    if (session) return session.stop(workerId);
    return this.assistedWorkerStatus(id, workerId);
  }

  assistedWorkerStatus(id: string, workerId: string): MediaAssistedWorkerReport {
    const job = this.job(id);
    const assistance = this.comparisons.get(id)?.snapshot() ?? this.audit(job.id).assistance;
    const worker = assistance?.workers.find((candidate) => candidate.workerId === workerId);
    if (!worker) throw new Error('Media assisted worker not found.');
    return { ...worker };
  }

  resume(id: string, owner?: MediaAnalysisOwner): MediaAnalysisReport {
    const job = this.job(id);
    if (job.status === 'cancelled')
      throw new Error('This media analysis was closed. Start a new analysis for this scope.');
    if (this.closing) throw new Error('Media analysis is closing.');
    if (owner) {
      const previous = JSON.parse(job.owner) as MediaAnalysisOwner | null;
      if (
        !previous ||
        owner.conversationId !== previous.conversationId ||
        (owner.projectPath === undefined) !== (previous.projectPath === undefined) ||
        (owner.projectPath &&
          previous.projectPath &&
          !samePath(resolve(owner.projectPath), resolve(previous.projectPath)))
      )
        throw new Error('Cannot transfer media analysis to another conversation or project.');
      // An explicit resume belongs to its current caller. An old stopped workflow must not pause it again.
      this.db.prepare('UPDATE jobs SET owner=? WHERE id=?').run(JSON.stringify(owner), id);
    }
    const active = this.active.get(id);
    if (active?.abort.signal.aborted) {
      this.recovery(id, true, 'active');
      this.prepareResume(id);
      this.update(id, 'queued', 'scanning', '等待正在停止的读取结束，然后从记录续跑。');
      void active.done
        .then(() => {
          if (!this.closing && this.job(id).status === 'queued') this.launch(id);
        })
        .catch(() => {});
    } else if (!active) {
      this.recovery(id, true, 'active');
      this.prepareResume(id);
      this.update(id, 'queued', 'scanning', '重新核对文件范围；复用未变更文件的本地证据。');
      this.launch(id);
    }
    return this.status(id);
  }

  cancel(id: string): MediaAnalysisReport {
    this.job(id);
    this.recovery(id, false, 'closed');
    this.active.get(id)?.abort.abort();
    this.update(id, 'cancelled', 'closed', '已关闭本地分析；现有记录保留，重新分析请新建任务。');
    return this.status(id);
  }

  pause(id: string, reason: 'user' | 'workflow' = 'user'): MediaAnalysisReport {
    const { status } = this.job(id);
    if (status === 'cancelled') throw new Error('This media analysis was closed.');
    // Only work in progress pauses. A finished, failed or already paused job keeps its status and evidence;
    // turning a completed job into a paused one would make resume discard and recompute its results.
    if (!['queued', 'running'].includes(status) && !this.active.has(id)) {
      if (status === 'interrupted') this.recovery(id, false, reason);
      return this.status(id);
    }
    this.recovery(id, false, reason);
    this.active.get(id)?.abort.abort();
    this.update(id, 'interrupted', 'paused', '已暂停本地分析，证据保留，可从此处续跑。');
    return this.status(id);
  }

  cancelForWorkflow(workflowId: string): void {
    for (const id of this.active.keys())
      if (this.status(id, { limit: 0 }).owner?.workflowId === workflowId) this.pause(id, 'workflow');
  }

  /** Startup may continue these jobs only after checking that their conversation/project still exists. */
  recoverable(): MediaAnalysisReport[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM jobs WHERE status='interrupted'
      AND json_extract(audit,'$.recovery.resumeWanted')=1
      AND json_extract(audit,'$.recovery.reason') IN ('shutdown','crash') ORDER BY created`,
      )
      .all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.status(id, { limit: 0 }));
  }

  list(conversationId?: string): MediaAnalysisReport[] {
    const rows =
      conversationId === undefined
        ? this.db
            .prepare(
              "SELECT id FROM jobs WHERE status!='cancelled' ORDER BY CASE WHEN status IN ('running','queued') THEN 0 ELSE 1 END, created DESC LIMIT 50",
            )
            .all()
        : this.db
            .prepare(
              "SELECT id FROM jobs WHERE status!='cancelled' AND json_extract(owner,'$.conversationId')=? ORDER BY CASE WHEN status IN ('running','queued') THEN 0 ELSE 1 END, created DESC LIMIT 50",
            )
            .all(conversationId);
    return (rows as Array<{ id: string }>).map((row) => this.status(row.id, { limit: 0 }));
  }

  async wait(id: string): Promise<MediaAnalysisReport> {
    await this.active.get(id)?.done;
    return this.status(id);
  }

  assertConversationsIdle(conversationIds: string[]) {
    const jobs = this.db
      .prepare(
        "SELECT id,status FROM jobs WHERE json_extract(owner,'$.conversationId') IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(conversationIds));
    if (jobs.some((job) => this.active.has(String(job.id)) || ['queued', 'running'].includes(String(job.status))))
      throw Error('这个项目的本地媒体任务尚未结束，请结束后再清空。');
  }
  purgeConversations(conversationIds: string[]) {
    this.assertConversationsIdle(conversationIds);
    const jobs = this.db
      .prepare("SELECT id FROM jobs WHERE json_extract(owner,'$.conversationId') IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(conversationIds));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const job of jobs) {
        for (const table of ['files', 'evidence', 'pair_cache', 'pair_checks'])
          this.db.prepare(`DELETE FROM ${table} WHERE job=?`).run(job.id);
        this.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const job of jobs) {
      this.steps.delete(String(job.id));
      this.lastUpdate.delete(String(job.id));
      this.comparisons.delete(String(job.id));
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    const tasks = [...this.active];
    const errors: unknown[] = [];
    // Failure to write a checkpoint must never leave a decoder or the next queued job running.
    for (const [, task] of tasks) task.abort.abort();
    for (const [id] of tasks) {
      try {
        if (['queued', 'running'].includes(this.job(id).status)) {
          this.recovery(id, true, 'shutdown');
          this.update(id, 'interrupted', 'paused', '应用关闭，分析进度已保留。');
        }
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      const results = await Promise.allSettled(tasks.map(([, task]) => task.done));
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    } finally {
      try {
        this.db.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Media analysis stopped, but checkpoint cleanup was incomplete.');
  }

  private job(id: string): JobRow {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) throw new Error('Invalid media analysis id.');
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow | undefined;
    if (!row) throw new Error('Media analysis not found.');
    return row;
  }
  private update(id: string, status: MediaAnalysisStatus, phase: string, progress: string) {
    if (status === 'completed' || status === 'failed') this.recovery(id, false, status);
    if (status === 'completed') this.steps.get(id)?.tracker.finish(this.clock());
    else if (status !== 'running') this.steps.get(id)?.tracker.pause(this.clock());
    this.db
      .prepare('UPDATE jobs SET status=?, phase=?, progress=?, updated=? WHERE id=?')
      .run(status, phase, progress, now(), id);
    if (status !== 'running' || Date.now() - (this.lastUpdate.get(id) ?? 0) >= 1000) {
      this.lastUpdate.set(id, Date.now());
      try {
        this.onUpdate?.(this.status(id, { limit: 1 }));
      } catch {
        /* Observers cannot interrupt local work. */
      }
    }
  }
  private note(id: string, text: string) {
    const notes = JSON.parse(this.job(id).coverage) as string[];
    if (!notes.includes(text) && notes.length < 30) {
      notes.push(text);
      this.db.prepare('UPDATE jobs SET coverage=? WHERE id=?').run(JSON.stringify(notes), id);
    }
  }
  private emptyAudit(options: StoredOptions): MediaAnalysisAudit {
    return {
      scope: {
        status: 'pending',
        fileLimit: options.maxFiles,
        listedFiles: 0,
        visitedEntries: 0,
        remainingDirectories: options.folders.slice(0, 20),
        remainingDirectoryCount: options.folders.length,
      },
      limits: [],
      execution: {
        requestedEngine: options.engine ?? 'auto',
        topK: options.topK ?? 8,
        videoSampleSeconds: options.videoSampleSeconds ?? 30,
        ...(options.retrievalMode === 'adaptive' ? { retrievalMode: 'adaptive' } : {}),
        ...(options.ioConcurrency !== undefined ? { ioConcurrency: options.ioConcurrency } : {}),
      },
      recovery: { resumeWanted: true, reason: 'active' },
    };
  }
  private audit(id: string): MediaAnalysisAudit {
    const job = this.job(id);
    const base = this.emptyAudit(JSON.parse(job.options) as StoredOptions);
    const stored = JSON.parse(job.audit) as Partial<MediaAnalysisAudit>;
    return {
      scope: stored.scope ?? base.scope,
      limits: stored.limits ?? [],
      execution: stored.execution ?? base.execution,
      ...(stored.resume ? { resume: stored.resume } : {}),
      ...(stored.recovery ? { recovery: stored.recovery } : {}),
      ...(stored.assistance ? { assistance: stored.assistance } : {}),
    };
  }
  private prepareResume(id: string) {
    const audit = this.audit(id);
    const phase = this.job(id).phase;
    if (this.job(id).status === 'queued' && audit.resume?.checkingFiles) return;
    const saved = this.db
      .prepare(
        'SELECT COUNT(*) AS files, SUM(CASE WHEN feature IS NOT NULL THEN 1 ELSE 0 END) AS fingerprinted FROM files WHERE job=? AND present=1',
      )
      .get(id) as { files: number; fingerprinted: number | null };
    const previous = audit.resume;
    audit.resume = {
      // A pause midway through inventory must not replace the full saved base with its partial present set.
      savedFiles: Math.max(saved.files, previous?.checkingFiles ? previous.savedFiles : 0),
      savedFingerprints: Math.max(saved.fingerprinted ?? 0, previous?.checkingFiles ? previous.savedFingerprints : 0),
      checkedFiles: 0,
      checkingFiles: true,
      ...(phase !== 'paused' && phase !== 'scanning'
        ? { previousPhase: phase }
        : previous?.previousPhase || audit.recovery?.previousPhase
          ? { previousPhase: previous?.previousPhase ?? audit.recovery?.previousPhase }
          : {}),
    };
    this.saveAudit(id, audit);
  }
  private saveAudit(id: string, audit: MediaAnalysisAudit) {
    this.db.prepare('UPDATE jobs SET audit=? WHERE id=?').run(JSON.stringify(audit), id);
  }
  private recovery(id: string, resumeWanted: boolean, reason: MediaAnalysisRecovery['reason']) {
    const job = this.job(id),
      audit = this.audit(id);
    const previousPhase =
      job.phase === 'paused' || job.phase === 'scanning'
        ? (audit.recovery?.previousPhase ?? audit.resume?.previousPhase)
        : job.phase;
    audit.recovery = { resumeWanted, reason, ...(previousPhase ? { previousPhase } : {}) };
    this.saveAudit(id, audit);
  }
  private limit(id: string, item: MediaAnalysisLimit) {
    const audit = this.audit(id);
    if (!audit.limits.some((existing) => existing.code === item.code)) {
      audit.limits.push(item);
      this.saveAudit(id, audit);
    }
    this.note(id, item.message);
  }
  private execution(id: string, actualEngine: 'gemma' | 'legacy') {
    const audit = this.audit(id);
    audit.execution = {
      ...audit.execution,
      actualEngine,
      modelId: undefined,
      backend: undefined,
    };
    this.saveAudit(id, audit);
  }
  private launch(id: string) {
    if (this.active.has(id)) return;
    const abort = new AbortController();
    const done = this.tail
      .catch(() => {})
      .then(async () => {
        try {
          abort.signal.throwIfAborted();
          await this.run(id, abort.signal);
        } catch (error) {
          if (!abort.signal.aborted) {
            try {
              this.update(id, 'failed', 'paused', `分析暂停：${message(error)} 已完成文件的证据保留。`);
            } catch {
              /* Disk failure must not terminate the conversation server. */
            }
          }
        }
      })
      .finally(() => {
        this.active.delete(id);
      });
    this.active.set(id, { abort, done });
    this.tail = done;
  }

  private async scan(id: string, options: StoredOptions, signal: AbortSignal) {
    this.db.prepare('UPDATE files SET present=0 WHERE job=?').run(id);
    const pending = [...options.folders];
    const unreadable: string[] = [];
    let count = 0,
      entries = 0;
    const saveScope = (status: MediaAnalysisScope['status'], remaining: string[]) => {
      const audit = this.audit(id);
      audit.scope = {
        status,
        fileLimit: options.maxFiles,
        listedFiles: count,
        visitedEntries: entries,
        remainingDirectories: remaining.slice(0, 20),
        remainingDirectoryCount: remaining.length,
      };
      if (audit.resume) audit.resume.checkedFiles = count;
      this.saveAudit(id, audit);
    };
    while (pending.length) {
      signal.throwIfAborted();
      const directory = pending.shift()!;
      let handle;
      try {
        if (!samePath(await realpath(directory), directory)) throw new Error('Folder changed to a symlink/junction.');
        handle = await opendir(directory);
        for await (const entry of handle) {
          signal.throwIfAborted();
          if (++entries > 200_000 || pending.length > 20_000) {
            this.limit(
              id,
              entries > 200_000
                ? {
                    code: 'entry-limit',
                    limit: 200_000,
                    message:
                      '目录条目达到 200000 个上限，尚有目录未枚举；同参数续跑不会自动继续剩余范围，需调整分析范围。',
                  }
                : {
                    code: 'directory-limit',
                    limit: 20_000,
                    message: '待扫描目录达到 20000 个上限，尚有目录未枚举；需调整分析范围。',
                  },
            );
            saveScope('partial', [directory, ...pending, ...unreadable]);
            return;
          }
          if (entries % 1000 === 0) {
            saveScope('pending', [directory, ...pending, ...unreadable]);
            this.step(id, 'scan', count, null);
            this.update(id, 'running', 'scanning', `已检查 ${entries} 个目录条目，找到 ${count} 个媒体文件。`);
          }
          if (entry.isSymbolicLink()) {
            this.note(id, '已跳过符号链接/junction，未跟随到范围外。');
            continue;
          }
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            if (!skipped.has(entry.name.toLowerCase())) pending.push(path);
            continue;
          }
          if (!entry.isFile()) continue;
          const kind = imagePattern.test(path) ? 'image' : videoPattern.test(path) ? 'video' : undefined;
          if (
            !kind ||
            (options.kind === 'images' && kind !== 'image') ||
            (options.kind === 'videos' && kind !== 'video')
          )
            continue;
          if (count >= options.maxFiles) {
            this.limit(id, {
              code: 'file-limit',
              limit: options.maxFiles,
              message: `媒体文件达到本批 ${options.maxFiles} 个上限，尚有媒体文件未列出；同参数续跑会重查本批，不能自动补齐剩余范围。分批核验还需比较跨批重复。`,
            });
            saveScope('partial', [directory, ...pending, ...unreadable]);
            return;
          }
          this.db
            .prepare(
              'INSERT INTO files(job,path,kind,present) VALUES(?,?,?,1) ON CONFLICT(job,path) DO UPDATE SET present=1',
            )
            .run(id, path, kind);
          count++;
          if (count % 100 === 0) {
            saveScope('pending', [directory, ...pending, ...unreadable]);
            this.step(id, 'scan', count, null);
            this.update(
              id,
              'running',
              'scanning',
              this.audit(id).resume
                ? `继续比对：已核对清单中的 ${count} 个媒体文件；未变文件的指纹记录会复用。`
                : `已找到 ${count} 个媒体文件。`,
            );
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        this.note(id, `未完整读取目录 ${directory}：${message(error)}`);
        unreadable.push(directory);
        this.limit(id, {
          code: 'unreadable-directory',
          message: '部分目录未能完整读取，范围未覆盖完整；错误目录及原因见 coverage。',
        });
      }
    }
    saveScope(unreadable.length ? 'partial' : 'complete', unreadable);
  }

  private async inspect(
    row: FileRow,
    roots: string[],
    signal: AbortSignal,
    plan: { hash: boolean; full: boolean },
    progress: (current: number, total: number) => void,
    checkpoint: (stamp: Stamp, feature: Feature) => void,
  ): Promise<{ stamp: Stamp; feature: Feature }> {
    const before = await fileStamp(row.path, roots);
    const existing = featureOf(row);
    const reusable = existing && row.stamp && equalStamp(before, stampOf(row)) ? existing : undefined;
    const required =
      row.kind === 'video' && reusable?.video
        ? samplingTimes(reusable.video.duration).filter((_time, index) => plan.full || coarseSamples.includes(index))
        : [];
    const moreFrames =
      row.kind === 'video' &&
      (!reusable?.video || required.some((time) => !reusable.frames?.some((frame) => frame.time === time)));
    if (reusable && reusable.errors.length === 0 && (!plan.hash || reusable.sha256) && !moreFrames)
      return { stamp: stampOf(row), feature: reusable };
    const sha256 = reusable?.sha256 ?? (plan.hash ? await contentHash(row.path, signal) : undefined);
    const feature: Feature = { ...(sha256 ? { sha256 } : {}), errors: [] };
    const settled = reusable && reusable.errors.length === 0 ? reusable : undefined;
    if (row.kind === 'image') {
      if (before.size > 200 * 1024 * 1024)
        feature.errors.push('Image exceeds the 200 MiB decode limit; exact hash only.');
      else if (settled?.image) feature.image = settled.image;
      else
        try {
          feature.image = await this.decoder.image(row.path, signal);
        } catch (error) {
          signal.throwIfAborted();
          feature.errors.push(message(error));
        }
    } else {
      try {
        feature.video = settled?.video ?? (await this.decoder.probe(row.path, signal));
        // A coarse pass takes a fixed subset of the full grid, so a later upgrade reuses those frames.
        const grid = samplingTimes(feature.video.duration);
        feature.planned = plan.full ? grid : coarseSamples.map((index) => grid[index]!);
        feature.frames = reusable?.frames ? [...reusable.frames] : [];
        let consecutiveErrors = 0;
        for (const time of feature.planned) {
          signal.throwIfAborted();
          if (feature.frames.some((frame) => frame.time === time)) continue;
          progress(feature.frames.length, feature.planned.length);
          try {
            feature.frames.push(await this.decoder.frame(row.path, time, signal));
            consecutiveErrors = 0;
          } catch (error) {
            signal.throwIfAborted();
            if (feature.errors.length < 4) feature.errors.push(`Frame ${time}s: ${message(error)}`);
            if (++consecutiveErrors >= 3) {
              feature.errors.push('Three consecutive decode failures; remaining positions are not covered.');
              break;
            }
          }
          checkpoint(before, {
            ...feature,
            errors: [...feature.errors, 'Frame decoding is incomplete; remaining positions are pending.'],
          });
        }
        feature.frames.sort((a, b) => a.time - b.time);
      } catch (error) {
        signal.throwIfAborted();
        feature.errors.push(message(error));
      }
    }
    if (!equalStamp(before, await fileStamp(row.path, roots)))
      throw new Error('File changed during analysis; cached evidence was not accepted.');
    return { stamp: before, feature };
  }

  /**
   * Which files need a full content hash. Identical files have equal sizes, so a file with a unique size is
   * never read for this; same-size files compare a head/tail sample first, and only matching samples are
   * hashed in full. A file already hashed in a checkpoint keeps that hash.
   */
  private async hashPlan(id: string, files: FileRow[], signal: AbortSignal): Promise<Set<number>> {
    const sizes = new Map<number, number>();
    for (const row of files) {
      signal.throwIfAborted();
      try {
        sizes.set(row.id, (await lstat(row.path)).size);
      } catch {
        /* inspect reports the unreadable file. */
      }
    }
    const count = (values: Iterable<string | number>) => {
      const counts = new Map<string | number, number>();
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    };
    const bySize = count(sizes.values());
    const shared = files.filter((row) => (bySize.get(sizes.get(row.id) ?? -1) ?? 0) > 1);
    const samples = new Map<number, string>();
    const full = new Set<number>();
    for (const [index, row] of shared.entries()) {
      signal.throwIfAborted();
      if (index % 200 === 0) {
        this.step(id, 'hash', index, shared.length);
        this.update(id, 'running', 'hashing', `按大小预筛：${index}/${shared.length} 个同大小文件比对首尾片段。`);
      }
      try {
        samples.set(row.id, await sampleHash(row.path, sizes.get(row.id)!));
      } catch {
        full.add(row.id); // Cannot sample: fall back to the full hash rather than assume a difference.
      }
    }
    const bySample = count(samples.values());
    for (const [rowId, sample] of samples) if ((bySample.get(sample) ?? 0) > 1) full.add(rowId);
    this.step(id, 'hash', shared.length, shared.length, `${full.size} 个文件需要整文件比对`);
    const skipped = files.length - full.size;
    if (skipped) this.note(id, `${skipped} 个文件的大小或首尾片段独一无二，不可能有完全相同的副本，未整文件读取哈希。`);
    return full;
  }

  /** Inspects files a few at a time; each finished file is checkpointed on its own. */
  private async inspectAll(
    id: string,
    rows: FileRow[],
    roots: string[],
    signal: AbortSignal,
    phase: string,
    label: string,
    plan: (row: FileRow) => { hash: boolean; full: boolean },
    workers = mediaWorkers,
  ) {
    let next = 0,
      done = 0;
    this.step(id, 'coarse', 0, rows.length);
    const worker = async () => {
      while (next < rows.length) {
        signal.throwIfAborted();
        const row = rows[next++]!;
        this.update(id, 'running', phase, `${label} ${done + 1}/${rows.length}：${row.path}`);
        try {
          const { stamp, feature } = await this.inspect(
            row,
            roots,
            signal,
            plan(row),
            (current, total) =>
              this.update(
                id,
                'running',
                phase,
                `${label} ${done + 1}/${rows.length}：已抽取 ${current}/${total} 个时间位置。`,
              ),
            (stamp, feature) => {
              this.db
                .prepare('UPDATE files SET stamp=?,feature=?,error=? WHERE id=?')
                .run(JSON.stringify(stamp), JSON.stringify(feature), '画面抽样进行中，尚未覆盖所有位置。', row.id);
            },
          );
          row.stamp = JSON.stringify(stamp);
          row.feature = JSON.stringify(feature);
          row.error = feature.errors.length ? feature.errors.join('; ') : null;
        } catch (error) {
          signal.throwIfAborted();
          row.feature = null;
          row.stamp = null;
          row.error = message(error);
        }
        this.db
          .prepare('UPDATE files SET stamp=?,feature=?,error=? WHERE id=?')
          .run(row.stamp, row.feature, row.error, row.id);
        done++;
        this.step(id, 'coarse', done, rows.length);
      }
    };
    // Every worker settles before this returns, so nothing keeps decoding after a pause or failure.
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(mediaWorkers, workers, rows.length) }, worker),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
  }

  private async run(id: string, signal: AbortSignal) {
    const options = JSON.parse(this.job(id).options) as StoredOptions;
    // Every run walks the same steps; checkpointed files simply pass through the early ones quickly.
    const previous = this.steps.get(id);
    if (previous) {
      previous.tracker.pause(this.clock());
      previous.list = (Object.keys(stepLabels) as StepKey[]).map((key) => ({
        key,
        label: stepLabels[key],
        state: 'pending',
        done: 0,
        total: null,
      }));
    }
    this.step(id, 'scan', 0, null);
    this.db.prepare('DELETE FROM evidence WHERE job=?').run(id);
    this.db.prepare("UPDATE jobs SET coverage='[]' WHERE id=?").run(id);
    const { resume, recovery } = this.audit(id);
    this.saveAudit(id, {
      ...this.emptyAudit(options),
      ...(resume ? { resume } : {}),
      ...(recovery ? { recovery } : {}),
    });
    this.update(
      id,
      'running',
      'scanning',
      resume
        ? `继续比对：核对已保存的文件清单；已保存 ${resume.savedFingerprints} 份指纹记录，未变且已完成的记录会复用。`
        : '枚举已指定目录，不读取其它素材目录。',
    );
    this.note(id, this.decoder.description);
    if (options.engine === 'gemma') this.note(id, '此流程的 Gemma 引擎已移除，本次使用本地指纹引擎。');
    await this.scan(id, options, signal);
    const audit = this.audit(id);
    if (audit.resume) {
      audit.resume.checkingFiles = false;
      this.saveAudit(id, audit);
    }
    const files = this.db.prepare('SELECT * FROM files WHERE job=? AND present=1 ORDER BY id').all(id) as FileRow[];
    this.step(id, 'scan', files.length, null);
    const fullHash = await this.hashPlan(id, files, signal);
    if (options.retrievalMode === 'adaptive') {
      await this.runAdaptive(id, files, options, fullHash, signal);
      return;
    }
    // Every file gets a cheap fingerprint; only videos that resemble another one get the full sampling grid.
    this.execution(id, 'legacy');
    await this.inspectAll(
      id,
      files,
      options.folders,
      signal,
      'fingerprinting',
      '本地读取',
      (row) => ({
        hash: fullHash.has(row.id),
        full: false,
      }),
      options.ioConcurrency,
    );
    this.note(
      id,
      '视频只查整段重复（时长相近、对应位置画面一致）；只截取另一条视频其中一段的局部重叠不在全库查找范围，这类文件都保留。',
    );
    const valid = files.filter((row) => row.feature && row.stamp);
    const hashIndex = new Map<string, FileRow>();
    const bandIndex = new Map<string, FileRow[]>();
    // Pairs that need decoding (image geometry, video fine check). Finding them is cheap and runs in order;
    // checking them is the slow part and runs several at once below.
    type Check =
      | { kind: 'image'; a: FileRow; b: FileRow; bits: number }
      | { kind: 'video'; a: FileRow; b: FileRow; visual: VisualEvidence; complete: boolean };
    const checks: Check[] = [];
    let compared = 0,
      recorded = 0,
      pruned = false;
    let indexed = 0;
    for (const row of valid) {
      if (++indexed % 16 === 0) await yieldToEventLoop();
      this.step(id, 'pairs', indexed, valid.length, `已找到 ${checks.length} 组待核对`);
      signal.throwIfAborted();
      const feature = featureOf(row)!;
      // Without a full hash the file's size or head/tail sample is unique, so no exact copy exists.
      const previous = feature.sha256 ? hashIndex.get(feature.sha256) : undefined;
      if (previous && stampOf(previous).size === stampOf(row).size) {
        if (recorded >= maxResults) {
          this.limit(id, {
            code: 'result-limit',
            limit: maxResults,
            message: `已达到 ${maxResults} 组证据上限，剩余重复组未发布；需调整范围补查。`,
          });
          continue;
        }
        if (
          await this.record(
            id,
            previous,
            row,
            {
              classification: 'exact-bytes',
              sha256: feature.sha256,
              explanation:
                '两个完整文件的 SHA-256 和字节数相同；这是内容哈希证据。尚未选择保留副本，也未执行回收；回收前需重新核对两个文件未变化。',
            },
            options.folders,
            signal,
          )
        )
          recorded++;
        continue;
      }
      if (feature.sha256) hashIndex.set(feature.sha256, row);
      // Videos are compared on their coarse positions, which every fingerprint has whether coarse or full.
      const own = feature.video ? coarseFrames(feature) : [];
      const signatures = feature.image ? [feature.image] : own.filter((frame) => !!frame);
      const candidates = new Map<number, FileRow>();
      for (const frame of signatures)
        if (frame.texture >= 10)
          for (let band = 0; band < 4; band++) {
            const key = `${row.kind}:${band}:${frame.hash.slice(band * 4, band * 4 + 4)}`;
            for (const other of bandIndex.get(key) ?? []) {
              if (candidates.size < 100) candidates.set(other.id, other);
              else pruned = true;
            }
          }
      for (const other of candidates.values()) {
        const comparedFeature = featureOf(other)!;
        // Only two videos of the same length can be one video end to end.
        if (
          feature.video &&
          (!comparedFeature.video || !sameLength(feature.video.duration, comparedFeature.video.duration))
        )
          continue;
        if (compared % 64 === 0) await yieldToEventLoop();
        signal.throwIfAborted();
        if (compared++ >= maxCandidates) {
          pruned = true;
          break;
        }
        const cached = this.db
          .prepare('SELECT data FROM pair_cache WHERE job=? AND a=? AND b=? AND key=?')
          .get(id, other.id, row.id, this.pairKey(other, row)) as { data: string } | undefined;
        if (cached) {
          const evidence = JSON.parse(cached.data) as MediaEvidence;
          if (await this.record(id, other, row, { ...evidence, reusedFromCheckpoint: true }, options.folders, signal))
            recorded++;
          continue;
        }
        if (feature.image && comparedFeature.image) {
          const bits = distance(feature.image, comparedFeature.image);
          if (bits !== undefined) checks.push({ kind: 'image', a: other, b: row, bits });
        } else if (feature.video && comparedFeature.video) {
          const theirs = coarseFrames(comparedFeature);
          const visual = compareVideoSamples(
            theirs.filter((frame) => !!frame),
            signatures,
            comparedFeature.video.duration,
            feature.video.duration,
          );
          // Every coarse position decoded on both sides, or a missing one could hide a difference.
          const complete = theirs.every(Boolean) && own.every(Boolean);
          if (visual) checks.push({ kind: 'video', a: other, b: row, visual, complete });
        }
      }
      for (const frame of signatures)
        if (frame.texture >= 10)
          for (let band = 0; band < 4; band++) {
            const key = `${row.kind}:${band}:${frame.hash.slice(band * 4, band * 4 + 4)}`;
            const bucket = bandIndex.get(key) ?? [];
            if (bucket.length < 128) {
              if (bucket.at(-1)?.id !== row.id) bucket.push(row);
              bandIndex.set(key, bucket);
            } else pruned = true;
          }
    }
    let checked = 0;
    this.step(id, 'compare', 0, checks.length);
    const check = async (item: Check) => {
      if (item.kind === 'image') {
        let imageFineCheck: MediaEvidence['imageFineCheck'];
        try {
          imageFineCheck = await this.decoder.compareImages?.(item.a.path, item.b.path, signal);
        } catch {
          signal.throwIfAborted();
          this.note(id, '有图片候选未完成几何精核，保留为待人工核对的候选。');
        }
        if (
          await this.record(
            id,
            item.a,
            item.b,
            {
              classification: 'image-candidate',
              imageFineCheck,
              explanation: `整张缩放后的图片指纹相近（64 位 dHash 距离 ${item.bits}）${imageFineCheck ? `，ORB 几何一致点 ${imageFineCheck.geometricInliers}` : ''}；未证明原始像素或内容完全相同，不能据此回收。`,
            },
            options.folders,
            signal,
          )
        )
          recorded++;
        return;
      }
      const { visual } = item;
      const durationA = featureOf(item.a)!.video!.duration,
        durationB = featureOf(item.b)!.video!.duration;
      // All six coarse positions agreeing is already strong; eight more aligned positions confirm the span.
      // A weaker coarse match gets the full sixteen.
      const planned = visual.coverage === 'sampled-full-span' && visual.matches === coarseSamples.length ? 8 : 16;
      const checkpointKey = this.completedPairKey(
        item.a,
        item.b,
        options,
        'legacy',
        visual.positions.map((position) => ({ a: position.a, b: position.b, score: position.distance })),
      );
      if (await this.hasCompletedPair(id, item.a, item.b, checkpointKey, options.folders, signal)) return;
      const result = await this.fineCheck(
        item.a.path,
        item.b.path,
        visual,
        durationA,
        durationB,
        signal,
        planned,
        Math.min(2, options.ioConcurrency ?? 2),
      );
      if (result.failed) this.note(id, '有候选未完成补充抽样精核；失败的位置未被当作相同或不同，续跑会重试。');
      if (result.matches < Math.min(4, result.planned)) {
        if (item.complete && result.failed === 0 && result.decoded === result.planned && result.planned > 0)
          await this.saveCompletedPair(id, item.a, item.b, checkpointKey, options.folders, signal);
        return;
      }
      visual.fineCheck = result;
      if (result.failed || result.matches !== result.planned || !item.complete) visual.coverage = 'partial-overlap';
      if (result.failed || result.matches !== result.planned || !item.complete) delete visual.sampledContainment;
      if (
        await this.record(
          id,
          item.a,
          item.b,
          {
            classification: visual.coverage,
            visual,
            explanation: videoExplanation(visual),
          },
          options.folders,
          signal,
        )
      )
        recorded++;
    };
    let next = 0;
    const worker = async () => {
      while (next < checks.length) {
        signal.throwIfAborted();
        if (recorded >= maxResults) {
          this.limit(id, {
            code: 'result-limit',
            limit: maxResults,
            message: `已达到 ${maxResults} 组证据上限，剩余候选未核验；同参数重跑不能保证覆盖剩余候选，需调整范围。`,
          });
          this.step(id, 'compare', checked, checks.length, '受证据上限提前结束，剩余候选未核验。');
          break;
        }
        await check(checks[next++]!);
        checked++;
        this.step(id, 'compare', checked, checks.length, `已找到 ${recorded} 组证据`);
        this.update(id, 'running', 'comparing', `逐对精核 ${checked}/${checks.length}，已找到 ${recorded} 组证据。`);
      }
    };
    // Every worker settles before this returns, so nothing keeps decoding after a pause or failure.
    const outcomes = await Promise.allSettled(
      Array.from(
        {
          length: Math.min(
            mediaWorkers,
            checks.length,
            options.ioConcurrency === undefined ? mediaWorkers : Math.max(1, Math.floor(options.ioConcurrency / 2)),
          ),
        },
        worker,
      ),
    );
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    if (pruned)
      this.limit(id, {
        code: 'candidate-limit',
        limit: maxCandidates,
        message:
          '高频指纹或候选数量达到上限；视觉候选未穷举，请调整范围补查，跨批重复仍需比较。文件哈希阶段仍按列出的文件完成。',
      });
    if (files.some((row) => row.error))
      this.note(id, '部分文件未能读取、未完成画面解码或超过解码限制；这些文件没有被假定为不同或重复。可续跑重试。');
    this.note(
      id,
      '视觉筛选针对缩放/转码及固定时间偏移，不保证找到所有裁剪、变速、拼接或遮挡；抽样不等于逐帧及音轨完全一致。',
    );
    signal.throwIfAborted();
    this.finishSteps(id);
    this.update(id, 'completed', 'completed', `本轮本地分析结束，${recorded} 组证据；范围及未覆盖项见 coverage。`);
  }

  /** Cheap whole-scope fingerprints retrieve bounded candidates for local verification. */
  private async prepareStaging(id: string, pairs: Array<{ a: FileRow; b: FileRow }>) {
    if (!this.stagingOptions || !pairs.some((pair) => pair.a.kind === 'video')) return undefined;
    const videoPairs = pairs.filter((pair) => pair.a.kind === 'video');
    let budget: { maxBytes?: number; minFreeBytes?: number } = {};
    if (this.automaticStagingBudget && this.stagingOptions.maxBytes === undefined) {
      let volumePath = this.stagingOptions.cacheRoot;
      while (true) {
        try {
          const volume = await statfs(volumePath);
          budget = mediaStagingBudget(volume.bavail * volume.bsize, videoPairs.length);
          break;
        } catch (error) {
          const parent = dirname(volumePath);
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === volumePath) break;
          volumePath = parent;
        }
      }
    }
    const cache = new LocalMediaStagingCache({
      ...budget,
      ...this.stagingOptions,
      maxBytes: this.stagingOptions.maxBytes ?? budget.maxBytes,
      minFreeBytes: this.stagingOptions.minFreeBytes ?? budget.minFreeBytes,
      cacheRoot: join(this.stagingOptions.cacheRoot, id),
      note: (message) => this.note(id, message),
    });
    cache.plan(videoPairs.flatMap((pair) => [pair.a.path, pair.b.path]));
    this.note(id, '待核验视频按组合临时复制到本机缓存；复用副本，用完清理，原件保留。');
    return cache;
  }

  private async stagedVideoCheck(
    id: string,
    cache: LocalMediaStagingCache | undefined,
    a: FileRow,
    b: FileRow,
    anchors: Array<{ a: number; b: number; score: number }>,
    signal: AbortSignal,
    readers: number,
  ) {
    if (!cache) return this.verifyVideoCandidates(a, b, anchors, signal, readers);
    try {
      return await cache.withPair([a.path, b.path], signal, (local, trustedIdentities, trustedOriginalIdentities) =>
        this.readContext.run(
          [a.path, b.path],
          local,
          () => this.verifyVideoCandidates(a, b, anchors, signal, readers),
          trustedIdentities,
          trustedOriginalIdentities,
        ),
      );
    } catch {
      signal.throwIfAborted();
      // A changed source/copy must neither publish evidence nor create a negative checkpoint.
      this.note(id, '视频原件或临时副本变化、读取失败，该组合保留为待核验；未保存重复或不同结论。');
      return { visual: undefined, completed: false };
    }
  }

  private async runAdaptive(
    id: string,
    files: FileRow[],
    options: StoredOptions,
    fullHash: Set<number>,
    signal: AbortSignal,
  ) {
    this.execution(id, 'legacy');
    this.note(id, '自适应快速流程：先并行计算图片指纹和视频 6 个位置，再由本地程序核验疑似组合；无需模型。');
    await this.inspectAll(
      id,
      files,
      options.folders,
      signal,
      'fingerprinting',
      '程序预筛',
      (row) => ({
        hash: fullHash.has(row.id),
        full: false,
      }),
      options.ioConcurrency,
    );
    type Pair = {
      a: FileRow;
      b: FileRow;
      anchors: Array<{ a: number; b: number; score: number }>;
    };
    const selected = new RankedMediaCandidates<Pair>(maxCandidates);
    const bands = new Map<string, Array<{ row: FileRow; frame: FrameSignature }>>();
    const hashes = new Map<string, FileRow>();
    let recorded = 0;
    let pruned = false;
    for (const [index, row] of files.entries()) {
      signal.throwIfAborted();
      if (index % 16 === 0) await yieldToEventLoop();
      const feature = featureOf(row);
      if (!feature || !row.stamp) continue;
      const identical = feature.sha256 ? hashes.get(feature.sha256) : undefined;
      if (identical && stampOf(identical).size === stampOf(row).size) {
        if (
          await this.record(
            id,
            identical,
            row,
            {
              classification: 'exact-bytes',
              sha256: feature.sha256,
              explanation: '完整文件 SHA-256 与字节数相同；尚未选择保留副本。回收前须另行核对授权及文件未变化。',
            },
            options.folders,
            signal,
          )
        )
          recorded++;
        continue;
      }
      if (feature.sha256) hashes.set(feature.sha256, row);
      const frames = feature.image
        ? [feature.image]
        : feature.video
          ? coarseFrames(feature).filter((frame) => !!frame)
          : [];
      const candidates = new Map<number, Pair>();
      for (const frame of frames) {
        if (frame.texture < 10) continue;
        for (let band = 0; band < 4; band++) {
          const key = `${row.kind}:${band}:${frame.hash.slice(band * 4, band * 4 + 4)}`;
          for (const hit of bands.get(key) ?? []) {
            const bits = distance(hit.frame, frame);
            if (bits === undefined) continue;
            if (!candidates.has(hit.row.id) && candidates.size >= 100) {
              pruned = true;
              continue;
            }
            const pair = candidates.get(hit.row.id) ?? { a: hit.row, b: row, anchors: [] };
            if (!pair.anchors.some((anchor) => anchor.a === hit.frame.time && anchor.b === frame.time))
              pair.anchors.push({ a: hit.frame.time, b: frame.time, score: 1 - bits / 64 });
            pair.anchors.sort((a, b) => b.score - a.score);
            pair.anchors.length = Math.min(24, pair.anchors.length);
            candidates.set(hit.row.id, pair);
          }
        }
      }
      const chosen = [...candidates.values()]
        .sort(
          (a, b) => b.anchors[0]!.score - a.anchors[0]!.score || b.anchors.length - a.anchors.length || a.a.id - b.a.id,
        )
        .slice(0, options.topK ?? 8);
      chosen.forEach((pair, rank) => selected.add(rank, pair));
      for (const frame of frames) {
        if (frame.texture < 10) continue;
        for (let band = 0; band < 4; band++) {
          const key = `${row.kind}:${band}:${frame.hash.slice(band * 4, band * 4 + 4)}`;
          const bucket = bands.get(key) ?? [];
          if (bucket.length >= 128) {
            bucket.splice(16, 1);
            pruned = true;
          }
          bucket.push({ row, frame });
          bands.set(key, bucket);
        }
      }
      this.step(id, 'pairs', index + 1, files.length, `程序已找到 ${selected.length} 组候选`);
      this.update(
        id,
        'running',
        'candidates',
        `程序筛选 ${index + 1}/${files.length}，已找到 ${selected.length} 组候选。`,
      );
    }
    const checks = selected.values();
    if (selected.pruned || pruned)
      this.limit(id, {
        code: 'candidate-limit',
        limit: maxCandidates,
        message: '程序指纹桶或候选预算有剪枝，已优先分配各文件的第一候选；未命中不能认定为不同，跨批重复仍需补查。',
      });
    const workQueue = new MediaWorkQueue(checks, (pair) => [pair.a.path, pair.b.path]);
    const staging = await this.prepareStaging(id, checks);
    if (signal.aborted) {
      await staging?.close();
      signal.throwIfAborted();
    }
    const sourceUses = new Map<string, number>();
    const sourceSizes = new Map<string, number>();
    for (const pair of checks)
      for (const row of [pair.a, pair.b]) {
        sourceUses.set(row.path, (sourceUses.get(row.path) ?? 0) + 1);
        if (!sourceSizes.has(row.path)) sourceSizes.set(row.path, stampOf(row).size);
      }
    let checked = 0,
      checkedFront = 0,
      checkedBack = 0,
      reusedChecks = 0;
    const workerCount = Math.min(
      4,
      mediaWorkers,
      checks.length,
      options.ioConcurrency === undefined ? 4 : Math.max(1, Math.floor(options.ioConcurrency / 2)),
    );
    if (workerCount > 1) this.note(id, '前向、尾向同时核验，每组只领取一次；未变更素材的已完成检查从缓存复用。');
    this.step(id, 'compare', 0, checks.length);
    const verify = async (pair: Pair, workerSignal: AbortSignal, readers: number, stagingReserved = true) => {
      let stagingConsumed = false;
      let freshCompleted = false;
      try {
        try {
          const stamps = await Promise.all([
            fileStamp(pair.a.path, options.folders),
            fileStamp(pair.b.path, options.folders),
          ]);
          if (!equalStamp(stamps[0]!, stampOf(pair.a)) || !equalStamp(stamps[1]!, stampOf(pair.b))) {
            this.note(id, '核验前素材已变化，未读取旧候选或发布证据。');
            return;
          }
        } catch {
          workerSignal.throwIfAborted();
          this.note(id, '核验前素材路径或访问权限变化，该候选保留为未完成。');
          return;
        }
        const checkpointKey = this.completedPairKey(pair.a, pair.b, options, 'adaptive', pair.anchors);
        if (await this.hasCompletedPair(id, pair.a, pair.b, checkpointKey, options.folders, workerSignal)) {
          reusedChecks++;
          return;
        }
        const cachedPair = this.db
          .prepare('SELECT data FROM pair_cache WHERE job=? AND a=? AND b=? AND key=?')
          .get(id, pair.a.id, pair.b.id, this.pairKey(pair.a, pair.b)) as { data: string } | undefined;
        if (cachedPair) {
          if (
            await this.record(
              id,
              pair.a,
              pair.b,
              { ...JSON.parse(cachedPair.data), reusedFromCheckpoint: true },
              options.folders,
              workerSignal,
            )
          ) {
            recorded++;
            reusedChecks++;
          }
          return;
        }
        if (pair.a.kind === 'image') {
          let fine: MediaEvidence['imageFineCheck'];
          let completed = false;
          try {
            fine = await this.decoder.compareImages?.(pair.a.path, pair.b.path, workerSignal);
            completed = !!fine && Number.isFinite(fine.geometricInliers) && fine.geometricInliers >= 0;
          } catch {
            workerSignal.throwIfAborted();
            this.note(id, '有图片候选未完成几何核验，仍保留为待核对候选。');
          }
          const left = featureOf(pair.a)?.image,
            right = featureOf(pair.b)?.image;
          const bits = left && right ? distance(left, right) : undefined;
          if ((fine && fine.geometricInliers >= 20) || bits !== undefined) {
            if (
              await this.record(
                id,
                pair.a,
                pair.b,
                {
                  classification: 'image-candidate',
                  imageFineCheck: fine,
                  explanation: `程序图片候选经独立核验${fine ? `，ORB 一致点 ${fine.geometricInliers}` : ''}${bits !== undefined ? `，dHash 距离 ${bits}` : ''}；未证明原始内容完全相同，不能据此回收。`,
                },
                options.folders,
                workerSignal,
              )
            )
              recorded++;
          } else if (completed)
            await this.saveCompletedPair(id, pair.a, pair.b, checkpointKey, options.folders, workerSignal);
          freshCompleted = completed;
        } else {
          stagingConsumed = !!staging && stagingReserved;
          const { visual, completed } = await this.stagedVideoCheck(
            id,
            stagingReserved ? staging : undefined,
            pair.a,
            pair.b,
            pair.anchors,
            workerSignal,
            readers,
          );
          if (
            visual &&
            (await this.record(
              id,
              pair.a,
              pair.b,
              {
                classification: visual.coverage,
                visual,
                explanation: videoExplanation(visual),
              },
              options.folders,
              workerSignal,
            ))
          )
            recorded++;
          if (!visual && completed)
            await this.saveCompletedPair(id, pair.a, pair.b, checkpointKey, options.folders, workerSignal);
          freshCompleted = completed;
        }
        return freshCompleted;
      } finally {
        if (staging && stagingReserved && pair.a.kind === 'video' && !stagingConsumed)
          await staging.finishPair([pair.a.path, pair.b.path]);
      }
    };
    const baseReaders = Math.min(2, options.ioConcurrency ?? 2);
    const assistance: MediaAssistanceReport = {
      workers: this.audit(id).assistance?.workers.map((entry) => ({ ...entry })) ?? [],
      maxWorkers: Math.max(0, Math.min(2, 8 - workerCount * baseReaders)),
      baseWorkers: workerCount,
      maxFrameReaders: workerCount * baseReaders + Math.max(0, Math.min(2, 8 - workerCount * baseReaders)),
    };
    const assisted = new Map<
      string,
      {
        report: MediaAssistedWorkerReport;
        abort: AbortController;
        done: Promise<void>;
        started: number;
      }
    >();
    const returnedWithoutStaging = new Set<number>();
    let comparisonClosing = false;
    const snapshotAssistance = (): MediaAssistanceReport => ({
      ...assistance,
      workers: assistance.workers.map((entry) => {
        const active = assisted.get(entry.workerId);
        return {
          ...entry,
          ...(active && (entry.status === 'running' || entry.status === 'waiting')
            ? { elapsedSeconds: Math.max(0, (this.clock() - active.started) / 1000) }
            : {}),
        };
      }),
    });
    const saveAssistance = () => {
      const audit = this.audit(id);
      audit.assistance = snapshotAssistance();
      this.saveAudit(id, audit);
    };
    const publishProgress = () => {
      if (signal.aborted) return;
      const helperCount = assistance.workers.reduce((sum, entry) => sum + entry.checked, 0);
      const suffix = helperCount ? `，协助尾查 ${helperCount} 组` : '';
      this.step(
        id,
        'compare',
        checked,
        checks.length,
        `前向 ${checkedFront} 组、尾向 ${checkedBack} 组${suffix}；证据 ${recorded} 组，复用已完成检查 ${reusedChecks} 组`,
      );
      this.update(
        id,
        'running',
        'comparing',
        `程序核验 ${checked}/${checks.length}，已找到 ${recorded} 组证据；前向 ${checkedFront} 组、尾向 ${checkedBack} 组${suffix}，缓存复用 ${reusedChecks} 组。`,
      );
    };
    const governor = new MediaPerformanceGovernor({
      ...this.performanceOptions,
      now: this.performanceOptions.now ?? this.clock,
      baseFrameReaders: workerCount * baseReaders,
      maxAssistants: assistance.maxWorkers,
      pressure: () => staging?.performanceSnapshot(),
      onChange: () => {
        if (this.comparisons.has(id) && !signal.aborted) this.update(id, 'running', 'comparing', this.job(id).progress);
      },
    });
    const workBucket = (pair: Pair) => {
      const duration =
        pair.a.kind === 'video'
          ? Math.max(featureOf(pair.a)?.video?.duration ?? 0, featureOf(pair.b)?.video?.duration ?? 0)
          : 0;
      const bytes = Math.max(stampOf(pair.a).size, stampOf(pair.b).size);
      return `${pair.a.kind}:${Math.floor(Math.log2(Math.max(1, duration)))}:${Math.floor(Math.log2(Math.max(1, bytes)))}:${Math.min(3, pair.anchors.length)}`;
    };
    const worker = async (
      direction: 'front' | 'back',
      workerSignal = signal,
      readers = baseReaders,
      helper?: MediaAssistedWorkerReport,
    ) => {
      while (workQueue.remaining > 0) {
        workerSignal.throwIfAborted();
        if (recorded >= maxResults) {
          this.limit(id, {
            code: 'result-limit',
            limit: maxResults,
            message: '证据结果达到上限，剩余候选未核验；需要调整范围补查。',
          });
          this.step(id, 'compare', checked, checks.length, '受证据上限提前结束，剩余候选未核验。');
          break;
        }
        let releasePermit: (() => void) | undefined;
        if (helper) {
          helper.status = 'waiting';
          helper.updatedAt = now();
          saveAssistance();
          releasePermit = await governor.acquire(
            workerSignal,
            () => workQueue.remaining === 0 || recorded >= maxResults,
          );
          if (!releasePermit) break;
          if (workerSignal.aborted) {
            releasePermit();
            workerSignal.throwIfAborted();
          }
          helper.status = 'running';
        }
        const cachedSources = staging?.cachedPaths();
        const item = workQueue.claim(
          direction,
          cachedSources
            ? {
                preferredSources: cachedSources,
                lookahead: 128,
                score: (pair) =>
                  mediaStagingPairPriority(
                    [pair.a, pair.b].map((row) => ({ path: row.path, size: sourceSizes.get(row.path)! })),
                    cachedSources,
                    sourceUses,
                  ),
              }
            : undefined,
        );
        governor.notifyQueueChanged();
        if (!item) {
          releasePermit?.();
          break;
        }
        if (helper) {
          helper.activePair = item.index + 1;
          helper.updatedAt = now();
          saveAssistance();
        }
        const stagingReserved = !returnedWithoutStaging.delete(item.index);
        try {
          const fresh = await verify(item.value, workerSignal, readers, stagingReserved);
          if (fresh) governor.recordFreshCompletion(workBucket(item.value));
          // A stop that arrived after the fixed check finished must not discard its valid checkpoint.
          workQueue.complete(item.index);
          governor.notifyQueueChanged();
        } catch (error) {
          if (!signal.aborted) {
            workQueue.release(item.index);
            // The aborted attempt already consumed this pair's staging references in its finally block.
            // Its retry uses originals/frame-cache rather than consuming another pair's plan references.
            returnedWithoutStaging.add(item.index);
          } else workQueue.complete(item.index);
          throw error;
        } finally {
          releasePermit?.();
        }
        checked++;
        if (direction === 'front') checkedFront++;
        else checkedBack++;
        if (helper) {
          helper.checked++;
          helper.updatedAt = now();
          delete helper.activePair;
          saveAssistance();
        }
        // A parent pause owns the job status; no late verifier result may turn it back into running.
        if (!signal.aborted) publishProgress();
      }
    };
    this.comparisons.set(id, {
      snapshot: snapshotAssistance,
      performance: () => governor.snapshot(),
      attach: (input) => {
        if (comparisonClosing || signal.aborted) throw new Error('Media comparison is stopping.');
        const previous = assistance.workers.find((entry) => entry.workerId === input.workerId);
        if (previous) {
          if (previous.accountLabel !== input.accountLabel || previous.runtimeId !== input.runtimeId)
            throw new Error('Media assisted worker identity cannot change.');
          return { ...previous };
        }
        if (assistance.workers.length >= 64) throw new Error('Media assisted worker history reached its limit.');
        if (
          [...assisted.values()].filter(
            (entry) => entry.report.status === 'running' || entry.report.status === 'waiting',
          ).length >= assistance.maxWorkers
        )
          throw new Error('Media assisted worker capacity reached.');
        if (workQueue.remaining === 0 || recorded >= maxResults) throw new Error('No pending media pairs to assist.');
        const report: MediaAssistedWorkerReport = {
          ...input,
          direction: 'back',
          status: 'running',
          checked: 0,
          startedAt: now(),
          updatedAt: now(),
          elapsedSeconds: 0,
        };
        const entry = { report, abort: new AbortController(), done: Promise.resolve(), started: this.clock() };
        assistance.workers.push(report);
        assisted.set(input.workerId, entry);
        const combined = AbortSignal.any([signal, entry.abort.signal]);
        saveAssistance();
        entry.done = (async () => {
          try {
            await worker('back', combined, 1, report);
            report.status = entry.abort.signal.aborted ? 'stopped' : 'completed';
          } catch {
            report.status = signal.aborted ? 'interrupted' : entry.abort.signal.aborted ? 'stopped' : 'failed';
            if (report.status === 'failed')
              report.error = 'Assisted fixed verification failed; unfinished pair returned.';
          } finally {
            report.updatedAt = now();
            report.elapsedSeconds = Math.max(0, (this.clock() - entry.started) / 1000);
            delete report.activePair;
            saveAssistance();
            if (!signal.aborted) publishProgress();
          }
        })();
        publishProgress();
        return { ...report };
      },
      stop: (workerId) => {
        const entry = assisted.get(workerId);
        if (entry && (entry.report.status === 'running' || entry.report.status === 'waiting'))
          entry.abort.abort(new Error('Assisted media worker stopped.'));
        const report = assistance.workers.find((candidate) => candidate.workerId === workerId);
        if (!report) throw new Error('Media assisted worker not found.');
        return { ...report };
      },
    });
    saveAssistance();
    publishProgress();
    let outcomes: PromiseSettledResult<void>[] = [];
    try {
      do {
        const baseline = await Promise.allSettled(
          Array.from({ length: workerCount }, (_value, index) => worker(index % 2 === 0 ? 'front' : 'back')),
        );
        outcomes.push(...baseline);
        if (baseline.some((outcome) => outcome.status === 'rejected')) {
          comparisonClosing = true;
          for (const entry of assisted.values()) entry.abort.abort(new Error('Main media verifier stopped.'));
        }
        // A drained queue can still have an assistant-owned in-flight pair. Join them before cleanup/completion.
        while (
          [...assisted.values()].some((entry) => entry.report.status === 'running' || entry.report.status === 'waiting')
        )
          await Promise.allSettled([...assisted.values()].map((entry) => entry.done));
        if (signal.aborted || baseline.some((outcome) => outcome.status === 'rejected') || recorded >= maxResults)
          break;
      } while (workQueue.remaining > 0);
    } finally {
      comparisonClosing = true;
      governor.close();
      this.comparisons.delete(id);
      await staging?.close();
    }
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) throw (failure as PromiseRejectedResult).reason;
    if (reusedChecks)
      this.note(id, `复用 ${reusedChecks} 组已完成的有界核验；仅表示相同采样计划已执行，不证明内容完全不同。`);
    if (files.some((row) => row.error))
      this.note(id, '部分素材未完成固定指纹读取；未读取位置不能认定相同或不同，可重试临时读取错误。');
    this.note(
      id,
      '快速程序预筛是有界候选查找；每视频 6 个位置可能漏掉很短的片段、旋转、裁剪或变速。matchedFractionA/B 仅为采样命中率；没有逐帧、音轨、字幕或真实画质完整核验，不宣称视觉查全。',
    );
    signal.throwIfAborted();
    this.finishSteps(id);
    this.update(id, 'completed', 'completed', `自适应本地程序分析结束，${recorded} 组证据。`);
  }

  private async verifyVideoCandidates(
    a: FileRow,
    b: FileRow,
    anchors: Array<{ a: number; b: number; score: number }>,
    signal: AbortSignal,
    readers = 2,
  ): Promise<{ visual?: VisualEvidence; completed: boolean }> {
    const durationA = featureOf(a)!.video!.duration,
      durationB = featureOf(b)!.video!.duration;
    const offsets: number[] = sameLength(durationA, durationB) ? [0] : [];
    for (const anchor of anchors) {
      const offset = anchor.b - anchor.a;
      if (!offsets.some((known) => Math.abs(known - offset) < 0.2)) offsets.push(offset);
      if (offsets.length >= 3) break;
    }
    let best: VisualEvidence | undefined;
    let attemptedOffsets = 0,
      decodeFailed = false;
    for (const offset of offsets) {
      const start = Math.max(0, -offset),
        end = Math.min(durationA, durationB - offset) - 0.1;
      if (end <= start) continue;
      attemptedOffsets++;
      const matches: Array<{ a: number; b: number; distance: number; hash: string }> = [];
      let failed = 0;
      const planned = 12;
      for (let i = 0; i < planned; i++) {
        signal.throwIfAborted();
        const time = start + ((end - start) * i) / (planned - 1);
        try {
          const [left, right] =
            readers === 1
              ? [
                  await this.decoder.frame(a.path, time, signal),
                  await this.decoder.frame(b.path, time + offset, signal),
                ]
              : await Promise.all([
                  this.decoder.frame(a.path, time, signal),
                  this.decoder.frame(b.path, time + offset, signal),
                ]);
          const bits = distance(left, right);
          if (bits !== undefined) matches.push({ a: time, b: time + offset, distance: bits, hash: left.hash });
        } catch {
          signal.throwIfAborted();
          failed++;
          decodeFailed = true;
          if (failed >= 3) {
            failed += planned - i - 1;
            break;
          }
        }
        // Even every remaining position matching cannot reach the existing four-hit threshold.
        // This is a completed rejection of this bounded sampling plan, not a claim of different full contents.
        if (matches.length + (planned - i - 1) < 4) break;
      }
      if (matches.length < 4 || new Set(matches.map((item) => item.hash)).size < 3) continue;
      const first = matches[0]!,
        last = matches.at(-1)!;
      if (last.a - first.a < (end - start) * 0.25) continue;
      const full =
        failed === 0 && matches.length === planned && Math.abs(durationA - durationB) <= 0.2 && Math.abs(offset) <= 0.2;
      const evidence: VisualEvidence = {
        matches: matches.length,
        samplesA: planned,
        samplesB: planned,
        offsetSeconds: offset,
        matchedFractionA: matches.length / planned,
        matchedFractionB: matches.length / planned,
        spanA: [first.a, last.a],
        spanB: [first.b, last.b],
        positions: matches.map(({ hash: _hash, ...item }) => item),
        coverage: full ? 'sampled-full-span' : 'partial-overlap',
        fineCheck: { planned, decoded: planned - failed, matches: matches.length, failed },
      };
      const containment = sampledContainment(evidence, durationA, durationB);
      if (containment) evidence.sampledContainment = containment;
      if (
        !best ||
        evidence.matches > best.matches ||
        (evidence.matches === best.matches && evidence.sampledContainment && !best.sampledContainment)
      )
        best = evidence;
      if (full) break;
    }
    signal.throwIfAborted();
    return { visual: best, completed: attemptedOffsets > 0 && !decodeFailed };
  }

  private async fineCheck(
    a: string,
    b: string,
    visual: VisualEvidence,
    durationA: number,
    durationB: number,
    signal: AbortSignal,
    planned = 16,
    readers = 2,
  ) {
    const start = Math.max(0, -visual.offsetSeconds, visual.spanA[0]),
      end = Math.min(durationA - 0.1, durationB - visual.offsetSeconds - 0.1, visual.spanA[1]);
    const result = { planned, decoded: 0, matches: 0, failed: 0 };
    if (end <= start) return result;
    let consecutiveErrors = 0;
    for (let index = 0; index < result.planned; index++) {
      signal.throwIfAborted();
      const time = start + ((end - start) * (index + 0.5)) / result.planned;
      try {
        // Both sides of a position decode at once; each decoder is single-threaded.
        const [left, right] =
          readers === 1
            ? [
                await this.decoder.frame(a, time, signal),
                await this.decoder.frame(b, time + visual.offsetSeconds, signal),
              ]
            : await Promise.all([
                this.decoder.frame(a, time, signal),
                this.decoder.frame(b, time + visual.offsetSeconds, signal),
              ]);
        result.decoded++;
        consecutiveErrors = 0;
        if (distance(left, right) !== undefined) result.matches++;
      } catch {
        signal.throwIfAborted();
        result.failed++;
        if (++consecutiveErrors >= 3) {
          result.failed += result.planned - index - 1;
          break;
        }
      }
    }
    return result;
  }

  private pairKey(a: FileRow, b: FileRow) {
    return createHash('sha256').update(`${a.stamp}\n${b.stamp}\n${a.feature}\n${b.feature}`).digest('hex');
  }

  private completedPairKey(
    a: FileRow,
    b: FileRow,
    options: StoredOptions,
    mode: 'legacy' | 'adaptive' | 'full-index',
    anchors: readonly { a: number; b: number; score: number }[],
  ) {
    return mediaPairCheckpointKey({
      pair: this.pairKey(a, b),
      mode,
      decoder: this.decoder.cacheIdentity ?? this.decoder.description,
      videoSampleSeconds: options.videoSampleSeconds ?? 30,
      anchors,
    });
  }

  /** Only successful bounded checks can be reused; absent/changed files remain unfinished. */
  private async hasCompletedPair(
    id: string,
    a: FileRow,
    b: FileRow,
    key: string,
    roots: string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (!this.db.prepare('SELECT 1 FROM pair_checks WHERE job=? AND a=? AND b=? AND key=?').get(id, a.id, b.id, key))
      return false;
    return this.pairIsCurrent(a, b, roots, signal);
  }

  private async saveCompletedPair(
    id: string,
    a: FileRow,
    b: FileRow,
    key: string,
    roots: string[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (featureOf(a)?.errors.length !== 0 || featureOf(b)?.errors.length !== 0) return;
    if (!(await this.pairIsCurrent(a, b, roots, signal))) return;
    signal.throwIfAborted();
    this.db
      .prepare('INSERT OR REPLACE INTO pair_checks(job,a,b,key,checked) VALUES(?,?,?,?,?)')
      .run(id, a.id, b.id, key, now());
  }

  private async pairIsCurrent(a: FileRow, b: FileRow, roots: string[], signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    try {
      const stamps = await Promise.all([fileStamp(a.path, roots), fileStamp(b.path, roots)]);
      signal.throwIfAborted();
      return equalStamp(stampOf(a), stamps[0]!) && equalStamp(stampOf(b), stamps[1]!);
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  private async record(
    id: string,
    a: FileRow,
    b: FileRow,
    evidence: Pick<
      MediaEvidence,
      'classification' | 'explanation' | 'visual' | 'sha256' | 'imageFineCheck' | 'reusedFromCheckpoint'
    > & { observedAt?: string },
    roots: string[],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    try {
      if (
        !equalStamp(stampOf(a), await fileStamp(a.path, roots)) ||
        !equalStamp(stampOf(b), await fileStamp(b.path, roots))
      ) {
        this.note(id, '比对期间有文件发生变化；对应证据未发布，请续跑重新核对。');
        return false;
      }
    } catch {
      signal.throwIfAborted();
      this.note(id, '比对期间有文件失去访问权限或路径变化；对应证据未发布。');
      return false;
    }
    signal.throwIfAborted();
    const item: MediaEvidence = {
      ...evidence,
      a: a.path,
      b: b.path,
      stamps: [stampOf(a), stampOf(b)],
      observedAt: evidence.observedAt ?? now(),
      deleteEligible: false,
      mediaA: knownMediaMetadata(a),
      mediaB: knownMediaMetadata(b),
    };
    // The final check is synchronous with insertion, so parallel verifiers cannot overrun the evidence budget.
    const count = (this.db.prepare('SELECT COUNT(*) AS count FROM evidence WHERE job=?').get(id) as { count: number })
      .count;
    if (
      count >= maxResults &&
      !this.db.prepare('SELECT 1 FROM evidence WHERE job=? AND a=? AND b=?').get(id, a.id, b.id)
    ) {
      this.limit(id, {
        code: 'result-limit',
        limit: maxResults,
        message: `已达到 ${maxResults} 组证据上限，剩余重复组未发布；需调整范围补查。`,
      });
      return false;
    }
    this.db
      .prepare('INSERT OR REPLACE INTO evidence(job,a,b,data) VALUES(?,?,?,?)')
      .run(id, a.id, b.id, JSON.stringify(item));
    if (!item.visual?.fineCheck?.failed && (item.classification !== 'image-candidate' || item.imageFineCheck))
      this.db
        .prepare('INSERT OR REPLACE INTO pair_cache(job,a,b,key,data) VALUES(?,?,?,?,?)')
        .run(id, a.id, b.id, this.pairKey(a, b), JSON.stringify(item));
    return true;
  }
}

/** Optional read-only check for a later, separately authorized recycle operation. Never recycles by itself. */
export async function verifyMediaRetainedCopy(
  candidate: string,
  retained: string,
  folders: string[],
  signal: AbortSignal,
) {
  if (samePath(resolve(candidate), resolve(retained))) throw new Error('The retained copy must be a different file.');
  const roots = await Promise.all(folders.map((folder) => realpath(folder)));
  const beforeA = await fileStamp(candidate, roots),
    beforeB = await fileStamp(retained, roots);
  if (beforeA.size !== beforeB.size) return { identical: false as const };
  const a = await contentHash(candidate, signal),
    b = await contentHash(retained, signal);
  if (!equalStamp(beforeA, await fileStamp(candidate, roots)) || !equalStamp(beforeB, await fileStamp(retained, roots)))
    throw new Error('A file changed while checking the retained copy.');
  return {
    identical: a === b,
    sha256: a === b ? a : undefined,
    candidate,
    retained,
    observedAt: now(),
    analysisOnly: true as const,
  };
}
