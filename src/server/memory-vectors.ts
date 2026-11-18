import { trackBusy, yieldToEventLoop } from './backend-activity.ts';
import { vectorCacheFile, survivingMemoryVectors } from './vector-cache.ts';
import { track } from './memory-telemetry.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embedTextsInWorker, prewarmTextsInWorker } from './image-match.ts';
import { onBattery } from './image-search.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import type { Project } from '../shared/types.ts';
import { appDirs } from './platform/dirs.ts';
import { runtimeDirectories } from '../../scripts/runtime-paths.mjs';
import { isMainThread } from 'node:worker_threads';
import { runMemoryVectorWorker } from './memory-vector-client.ts';

/*
 * Earlier conversation found by meaning, next to the keyword index (memory-index.ts): "the packaging error
 * last time" also finds a message that said "build failed". Each message's opening passages are embedded
 * with bge-m3 (text-embedding.ts) in the background on the CPU, and kept per
 * project in a private file. A question uses the same CPU session and is compared
 * with all of them; the retrieval worker then applies the usual visibility rules to the candidates.
 */

const size = 1024;
const passageLength = 700;
const passageStep = 600;
const passagesPerMessage = 3;
/**
 * Measured on real history: questions that were discussed score 0.69–0.76 for their best passage, unrelated
 * ones at most 0.65 (bge-m3 rates any two Chinese texts around 0.5–0.65). Below the bar nothing is returned;
 * above it, passages close to the best one come along.
 */
const relevantBest = 0.66;
const nearBest = 0.08;

export function memoryModelDirectory(appRoot: string): string | undefined {
  // Development keeps it in .runtime/memory-search; a packaged app in resources/memory-search.
  return runtimeDirectories(appRoot, 'memory-search').find(
    (dir) => existsSync(join(dir, 'model.onnx')) && existsSync(join(dir, 'tokenizer.json')),
  );
}

function vectorDirectory(): string {
  return process.env.COMBORUNNER_MEMORY_VECTORS_DIR || appDirs().vectors;
}

type Item = { messageId: string; offset: number; hash: string };
type Saved = { version: 1; items: Item[] };
/** One project's passages and their vectors (unit length, stored as int8). */
export class ProjectVectors {
  items: Item[] = [];
  vectors: Int8Array[] = [];
  persistedPassages = 0;
  private dirty = false;
  constructor(readonly projectId: string) {}
  static async open(projectId: string) {
    const value = new ProjectVectors(projectId);
    await value.load();
    return value;
  }
  private async load() {
    try {
      await mkdir(vectorDirectory(), { recursive: true });
      const base = join(vectorDirectory(), safeName(this.projectId));
      if (!existsSync(`${base}.json`) || !existsSync(`${base}.bin`)) return;
      const saved = await vectorCacheFile<Saved>(`${base}.json`);
      const file = await readFile(`${base}.bin`);
      // Small reads share Node's Buffer pool; only this file's view is part of the cache.
      const bytes = new Int8Array(file.buffer, file.byteOffset, file.byteLength);
      if (saved.version === 1 && bytes.length === saved.items.length * size) {
        this.items = saved.items;
        for (let index = 0; index < saved.items.length; index++) {
          if (index % 128 === 0) await yieldToEventLoop();
          this.vectors.push(bytes.slice(index * size, (index + 1) * size));
        }
        this.persistedPassages = saved.items.length;
      }
    } catch {
      /* Nothing saved yet. */
    }
  }
  replace(items: Item[], vectors: Int8Array[]) {
    this.items = items;
    this.vectors = vectors;
    this.dirty = true;
  }
  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(vectorDirectory(), { recursive: true });
    const base = join(vectorDirectory(), safeName(this.projectId));
    const { items, vectors } = this;
    const bytes = new Int8Array(vectors.length * size);
    for (let index = 0; index < vectors.length; index++) {
      if (index % 128 === 0) await yieldToEventLoop();
      bytes.set(vectors[index]!, index * size);
    }
    await writeFile(`${base}.bin.tmp`, bytes);
    await vectorCacheFile(`${base}.json.tmp`, { value: { version: 1, items } satisfies Saved });
    await rename(`${base}.bin.tmp`, `${base}.bin`);
    await rename(`${base}.json.tmp`, `${base}.json`);
    this.persistedPassages = items.length;
  }
}
const safeName = (projectId: string) => createHash('sha256').update(projectId).digest('hex').slice(0, 32);
const projects = new Map<string, Promise<ProjectVectors>>();
const vectorsFor = (projectId: string) => {
  const key = `${vectorDirectory()}:${projectId}`;
  let value = projects.get(key);
  if (!value) projects.set(key, (value = ProjectVectors.open(projectId)));
  return value;
};
const hashOf = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16);
const toBytes = (values: Float32Array) => Int8Array.from(values, (value) => Math.round(value * 127));

/** The opening passages of a message worth embedding (long tool output contributes its start only). */
export function passagesOf(content: string, limit = passagesPerMessage): Array<{ offset: number; text: string }> {
  // What a person wrote or was told: tool results are skipped, a reply stops where its tool calls begin, and
  // the wrapper around messages sent mid-task is left out. Offsets still point into the original message.
  if (/^\s*工具结果（历史记录）/.test(content)) return [];
  const opening = content.indexOf('<user_query>');
  const start = opening >= 0 && opening < 200 ? opening + '<user_query>'.length : 0;
  const ends = ['工具调用（历史记录', '</user_query>'].map((marker) => content.indexOf(marker, start));
  const end = Math.min(...ends.map((index) => (index < 0 ? content.length : index)));
  const passages: Array<{ offset: number; text: string }> = [];
  for (let offset = start; offset < end && passages.length < limit; offset += passageStep) {
    const text = content
      .slice(offset, Math.min(end, offset + passageLength))
      .replace(/```[\s\S]*?(?:```|$)/g, ' ')
      .replace(/<\/?[a-z_]+>/gi, ' ')
      .trim();
    if (text.replace(/\s+/g, '').length >= 4) passages.push({ offset, text });
  }
  return passages;
}

/**
 * Brings one project's vectors up to date with its messages, within a time budget: new and edited passages
 * are embedded (8 at a time), passages of removed messages dropped. Returns how many are left.
 */
async function indexMemoryNow(
  appRoot: string,
  store: WorkspaceStore,
  projectId: string,
  options: { until: number; signal?: AbortSignal; gpu?: boolean } = { until: Number.POSITIVE_INFINITY },
): Promise<number> {
  const owner = store.get<Project>('project', projectId);
  if (!owner || owner.removedAt) return 0;
  const model = memoryModelDirectory(appRoot);
  if (!model) return 0;
  const project = await vectorsFor(projectId);
  const previousItems = project.items,
    previousVectors = project.vectors;
  const known = new Map(previousItems.map((item, index) => [`${item.messageId}:${item.offset}`, index]));
  const items: Item[] = [];
  const vectors: Int8Array[] = [];
  let missing = 0,
    done = 0,
    stopped = false;
  let group: Array<Item & { text: string }> = [];
  const flush = async () => {
    if (!group.length) return;
    if (Date.now() > options.until || options.signal?.aborted) stopped = true;
    if (!stopped) {
      const embedded = await embedTextsInWorker(
        model,
        group.map((p) => p.text),
      ).catch(() => undefined);
      if (!embedded) stopped = true;
      else {
        group.forEach(({ text: _text, ...item }, row) => {
          items.push(item);
          vectors.push(toBytes(embedded.subarray(row * size, (row + 1) * size)));
        });
        done += group.length;
      }
    }
    group = [];
  };
  let rowCount = 0;
  for (const row of store.iterateMemoryIndexRows(projectId)) {
    if (rowCount++ % 32 === 0) await yieldToEventLoop();
    for (const passage of passagesOf(row.content)) {
      const item = { messageId: row.messageId, offset: passage.offset, hash: hashOf(passage.text) };
      const index = known.get(item.messageId + ':' + item.offset);
      if (index !== undefined && previousItems[index]!.hash === item.hash) {
        items.push(previousItems[index]!);
        vectors.push(previousVectors[index]!);
      } else {
        missing++;
        if (!stopped) {
          group.push({ ...item, text: passage.text });
          if (group.length === 8) await flush();
        }
      }
    }
  }
  await flush();
  project.replace(items, vectors);
  await project.save();
  return missing - done;
}

const prewarming = new Map<string, { promise: Promise<void>; until: number; active: boolean }>();
/** Called only for incoming user messages; failures leave normal keyword retrieval available. */
export async function prewarmMemory(
  appRoot: string,
  projectId: string,
  options: { warmLegacy?: typeof prewarmTextsInWorker; now?: number } = {},
): Promise<void> {
  try {
    const model = memoryModelDirectory(appRoot);
    if (!model || !(await vectorsFor(projectId)).persistedPassages) return Promise.resolve();
    const key = model;
    const now = options.now ?? Date.now();
    const previous = prewarming.get(key);
    if (previous && (previous.active || now < previous.until)) return previous.promise;
    const state = { promise: Promise.resolve(), until: now + 1000, active: true };
    state.promise = Promise.resolve()
      .then(() => (options.warmLegacy ?? prewarmTextsInWorker)(model))
      .catch(() => {})
      .finally(() => {
        state.active = false;
      });
    prewarming.set(key, state);
    return state.promise;
  } catch {
    return Promise.resolve();
  }
}

/** The passages closest in meaning to the question: message, where in it, and similarity. */
async function semanticCandidatesNow(
  appRoot: string,
  projectId: string,
  query: string,
  limit = 24,
): Promise<Array<{ messageId: string; offset: number; score: number; sourceHash?: string }>> {
  const model = memoryModelDirectory(appRoot);
  const project = model ? await vectorsFor(projectId) : undefined;
  if (!model || !project?.items.length || !query.trim()) return [];
  // One short question: the CPU answers in tens of milliseconds, with no graphics card warm-up.
  const question = await embedTextsInWorker(model, [query.slice(0, 2000)]);
  const { items, vectors } = project;
  const scored: Array<{ index: number; score: number }> = [];
  for (let index = 0; index < vectors.length; index++) {
    if (index % 128 === 0) await yieldToEventLoop();
    const vector = vectors[index]!;
    let dot = 0;
    for (let i = 0; i < size; i++) dot += vector[i]! * question[i]!;
    scored.push({ index, score: dot / 127 });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0]!.score < relevantBest) return [];
  const floor = scored[0]!.score - nearBest;
  const seen = new Set<string>();
  const out: Array<{ messageId: string; offset: number; score: number }> = [];
  for (const { index, score } of scored) {
    if (out.length >= limit || score < floor) break;
    const item = items[index]!;
    if (seen.has(item.messageId)) continue;
    seen.add(item.messageId);
    out.push({ messageId: item.messageId, offset: item.offset, score });
  }
  return out;
}

export async function memoryVectorStatus(appRoot: string, store: WorkspaceStore) {
  if (!memoryModelDirectory(appRoot)) return { model: false, passages: 0 };
  let passages = 0;
  for (const project of store.projects()) passages += (await vectorsFor(project.id)).items.length;
  return { model: true, passages, working: !!running };
}

// ——— Background ———

let timer: NodeJS.Timeout | undefined;
let running: AbortController | undefined;

/** Keeps every project's vectors current, a few minutes after start and then every ten minutes, on mains power. */
export function scheduleMemoryIndexing(appRoot: string, store: WorkspaceStore, delay = 120_000) {
  if (timer || running || process.env.COMBORUNNER_MEMORY_BACKGROUND === '0' || !memoryModelDirectory(appRoot)) return;
  timer = setTimeout(() => {
    timer = undefined;
    void pass(appRoot, store);
  }, delay);
  timer.unref();
}

async function pass(appRoot: string, store: WorkspaceStore) {
  let left = 0;
  if (!(await onBattery())) {
    const controller = (running = new AbortController());
    try {
      for (const project of store.projects()) {
        left += await indexMemory(appRoot, store, project.id, {
          until: Date.now() + 5 * 60_000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) break;
      }
    } catch {
      left = 0;
    } finally {
      running = undefined;
    }
  }
  scheduleMemoryIndexing(appRoot, store, left ? 30_000 : 10 * 60_000);
}

export function stopMemoryIndexing() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  running?.abort();
}

const indexing = new Map<string, Promise<unknown>>();
function serializeIndex<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const next = (indexing.get(projectId) ?? Promise.resolve()).catch(() => {}).then(work);
  indexing.set(projectId, next);
  void next
    .finally(() => {
      if (indexing.get(projectId) === next) indexing.delete(projectId);
    })
    .catch(() => {});
  return next;
}
export function pruneMemoryVectors(store: WorkspaceStore, projectId: string) {
  return serializeIndex(projectId, async () => {
    const owner = store.get<Project>('project', projectId);
    if (!owner || owner.removedAt) return;
    const project = await vectorsFor(projectId);
    const live = new Set(store.memoryIndexMembership(projectId).map((row) => row.messageId));
    const kept = survivingMemoryVectors(project.items, project.vectors, live);
    if (kept) {
      project.replace(kept.items, kept.vectors);
      await project.save();
    }
  });
}
export function memoryVectorCleanupPaths(projectId: string) {
  const root = vectorDirectory();
  const base = join(root, safeName(projectId));
  return { root, paths: ['.json', '.bin', '.json.tmp', '.bin.tmp'].map((suffix) => base + suffix) };
}
export function withProjectVectorCleanup<T>(projectId: string, cleanup: () => Promise<T>): Promise<T> {
  return serializeIndex(projectId, async () => {
    const key = `${vectorDirectory()}:${projectId}`;
    await projects.get(key)?.catch(() => {});
    projects.delete(key);
    return cleanup();
  });
}
export async function indexMemory(...args: Parameters<typeof indexMemoryNow>): Promise<number> {
  const end = track('local-memory-index');
  try {
    return await serializeIndex(args[2], async () => {
      const [appRoot, store, projectId, options] = args;
      const databasePath = store.db.location();
      // File-backed SQL and passage processing stay off the server thread. In-memory fixtures cannot be reopened.
      if (!isMainThread || !databasePath) return indexMemoryNow(...args);
      if (!memoryModelDirectory(appRoot)) return 0;
      try {
        return await runMemoryVectorWorker(
          {
            databasePath,
            appRoot,
            projectId,
            vectorDirectory: vectorDirectory(),
            until: options?.until ?? Date.now() + 5 * 60_000,
          },
          options?.signal,
        );
      } catch {
        // Retry later; an unavailable worker must never fall back to synchronous history scanning.
        return 1;
      } finally {
        projects.delete(`${vectorDirectory()}:${projectId}`);
      }
    });
  } finally {
    end();
  }
}

export async function semanticCandidates(...args: Parameters<typeof semanticCandidatesNow>) {
  const end = trackBusy('memory-vector-search');
  try {
    return await semanticCandidatesNow(...args);
  } finally {
    end();
  }
}
