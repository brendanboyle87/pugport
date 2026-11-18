import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, statfs, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import { trustedDirectory } from './platform/trusted-path.ts';

const GIB = 1024 ** 3;
const FORMAT = 'pugport-media-staging-v1';
const MARKER = '.pugport-media-staging.json';
const NAMESPACE = /^pugport-media-([a-f0-9-]{36})$/;
const ASSET = /^asset-[a-f0-9-]{36}(?:\.[a-z0-9]{1,12})?$/;

interface Stamp {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}

interface OwnedFile {
  name: string;
  dev: string;
  ino: string;
  size: number;
}

interface Marker {
  format: typeof FORMAT;
  token: string;
  ownerPid: number;
  cacheRoot: string;
  directory: string;
  dev: string;
  ino: string;
  files: OwnedFile[];
}

interface ReadyFile {
  localPath: string;
  originalStamp: Stamp;
  localStamp: Stamp;
}

interface RecordEntry {
  originalPath: string;
  refs: number;
  active: number;
  lastUsed: number;
  ready?: ReadyFile;
  /** Only a copy deadline, never cancellation or a decoder failure, suppresses another attempt. */
  timedOutStamp?: Stamp;
  retired: Set<string>;
}

interface Selection {
  originalPath: string;
  originalStamp: Stamp;
  localPath: string;
  localStamp: Stamp;
}

export interface LocalMediaStagingOptions {
  /** Dedicated per-job cache directory, outside the source media tree. */
  cacheRoot: string;
  /** Explicit limits may reach 64 GiB. The default remains 8 GiB. */
  maxBytes?: number;
  /** Limits above 8 GiB always preserve at least 32 GiB available on the cache volume. */
  minFreeBytes?: number;
  copyTimeoutMs?: number;
  note?: (message: string) => void;
  /** Test seam. Production uses statfs available bytes on the cache volume. */
  spaceAvailable?: (root: string) => Promise<number>;
}

export interface LocalMediaStagingPerformance {
  /** True only while an original-to-local streaming pipeline is active. */
  copying: boolean;
  /** Pairs waiting for serialized selection/copy; excludes the current selected pair. */
  pendingPairs: number;
  /** Pairs with active ownership, including selection and decoder callbacks. */
  activePairs: number;
  usedBytes: number;
  maxBytes: number;
  /** Cumulative streamed source bytes, including in-progress and aborted copy attempts. */
  copyBytes: number;
  /** Cumulative monotonic streaming time, including an in-progress copy. */
  copyMilliseconds: number;
}

export class MediaStagingChangedError extends Error {
  constructor() {
    super('Media file changed during local verification.');
    this.name = 'MediaStagingChangedError';
  }
}

function key(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inside(directory: string, file: string): boolean {
  const relative = path.relative(key(directory), key(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Permit only the documented packaged-app LocalAppData mapping for our dedicated media cache. */
export function isAllowedMsixMediaCacheMapping(
  logicalRoot: string,
  canonicalRoot: string,
  localAppData: string | undefined,
): boolean {
  if (!localAppData) return false;
  const win = path.win32;
  const normalize = (value: string): string | undefined => {
    // Drive-relative paths, UNC/device namespaces and traversal spellings are not a cache mapping.
    if (!/^[a-z]:[\\/]/i.test(value)) return undefined;
    const components = value.slice(3).replaceAll('/', '\\').split('\\');
    if (components.some((component) => component === '.' || component === '..')) return undefined;
    return win
      .normalize(value)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  };
  const local = normalize(localAppData);
  const logical = normalize(logicalRoot);
  const canonical = normalize(canonicalRoot);
  if (!local || !logical || !canonical) return false;
  const relative = (target: string): string[] | undefined => {
    const suffix = win.relative(local, target);
    if (win.isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..\\')) return undefined;
    return suffix.split('\\');
  };
  const logicalSuffix = relative(logical);
  const canonicalSuffix = relative(canonical);
  if (
    !logicalSuffix ||
    !canonicalSuffix ||
    logicalSuffix[0] !== 'pugport' ||
    logicalSuffix[1] !== 'cache' ||
    logicalSuffix[2] !== 'media-verification' ||
    canonicalSuffix[0] !== 'packages' ||
    !/^[a-z0-9][a-z0-9._-]{0,254}$/.test(canonicalSuffix[1] ?? '') ||
    canonicalSuffix[2] !== 'localcache' ||
    canonicalSuffix[3] !== 'local' ||
    canonicalSuffix.slice(4).join('\\') !== logicalSuffix.join('\\')
  ) {
    return false;
  }
  return true;
}

function stamp(stats: BigIntStats): Stamp {
  if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new MediaStagingChangedError();
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: Number(stats.size),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  };
}

function equalStamp(a: Stamp, b: Stamp): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function fileStamp(file: string): Promise<Stamp> {
  const stats = await lstat(file, { bigint: true });
  if (stats.isSymbolicLink() || key(await realpath(file)) !== key(file)) throw new MediaStagingChangedError();
  return stamp(stats);
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

async function safeRoot(directory: string, create: boolean, allowMsixMapping = true): Promise<string> {
  if (!path.isAbsolute(directory) || key(directory) === key(path.parse(directory).root)) {
    throw new Error('A dedicated absolute media cache directory is required.');
  }
  // Links above the cache folder belong to the system (macOS /var); the folder and everything below stay checked.
  const resolved = path.resolve(trustedDirectory(directory));
  const ancestors: string[] = [];
  for (let current = resolved; current !== path.dirname(current); current = path.dirname(current)) {
    ancestors.push(current);
  }
  for (const current of ancestors.reverse()) {
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Media cache directory cannot use aliases.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(current);
    }
  }
  const canonical = await realpath(resolved);
  if (key(canonical) !== key(resolved)) {
    if (
      process.platform !== 'win32' ||
      !allowMsixMapping ||
      !isAllowedMsixMediaCacheMapping(resolved, canonical, process.env.LOCALAPPDATA)
    ) {
      throw new Error('Media cache directory cannot use aliases.');
    }
    // Recheck the actual path and every ancestor; this exception does not authorize junctions.
    return safeRoot(canonical, false, false);
  }
  return canonical;
}

async function directoryMatches(directory: string, expected: Pick<Marker, 'dev' | 'ino'>): Promise<boolean> {
  try {
    const stats = await lstat(directory, { bigint: true });
    return (
      stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      String(stats.dev) === expected.dev &&
      String(stats.ino) === expected.ino &&
      key(await realpath(directory)) === key(directory)
    );
  } catch {
    return false;
  }
}

async function removeOwned(directory: string, owned: OwnedFile): Promise<boolean> {
  if (!ASSET.test(owned.name)) return false;
  const target = path.join(directory, owned.name);
  try {
    const stats = await lstat(target, { bigint: true });
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      String(stats.dev) !== owned.dev ||
      String(stats.ino) !== owned.ino
    ) {
      return false;
    }
    await unlink(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Bounded, serial source copying; concurrent verification may read the completed SSD copies.
 * All cache identities are tied to original stamps. Only decoder reads use the returned local paths.
 */
export class LocalMediaStagingCache {
  private readonly records = new Map<string, RecordEntry>();
  private readonly owned = new Map<string, OwnedFile>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly pendingCleanups = new Set<Promise<void>>();
  private readonly notes = new Set<string>();
  private readonly lifetime = new AbortController();
  private readonly options: Required<Pick<LocalMediaStagingOptions, 'maxBytes' | 'minFreeBytes' | 'copyTimeoutMs'>> &
    LocalMediaStagingOptions;
  private tail: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;
  private directory?: string;
  private marker?: Marker;
  private usedBytes = 0;
  private selectingPair = false;
  private pendingPairs = 0;
  private activePairs = 0;
  private copyBytes = 0;
  private copyMilliseconds = 0;
  private copyStarted?: number;
  /** Bounded recent successful streams; tiny metadata-dominated copies are not throughput evidence. */
  private readonly successfulCopyRates: number[] = [];
  private planned = false;
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: LocalMediaStagingOptions) {
    if (!path.isAbsolute(options.cacheRoot)) throw new Error('Media cache path must be absolute.');
    this.options = {
      ...options,
      maxBytes: Math.min(options.maxBytes ?? 8 * GIB, 64 * GIB),
      minFreeBytes: options.minFreeBytes ?? 4 * GIB,
      copyTimeoutMs: options.copyTimeoutMs ?? 120_000,
    };
    for (const value of [this.options.maxBytes, this.options.minFreeBytes, this.options.copyTimeoutMs]) {
      if (!Number.isFinite(value) || value < 0) throw new Error('Media cache limits must be finite and nonnegative.');
    }
    if (this.options.maxBytes > 8 * GIB) this.options.minFreeBytes = Math.max(this.options.minFreeBytes, 32 * GIB);
  }

  /** Scheduling hints only; every copy and original identity is still checked by withPair. */
  cachedPaths(): ReadonlySet<string> {
    if (this.closed) return new Set();
    return new Set([...this.records.values()].filter((record) => record.ready).map((record) => record.originalPath));
  }

  /** In-memory sampling only. Consumers can derive recent copy throughput from successive deltas. */
  performanceSnapshot(): LocalMediaStagingPerformance {
    return {
      copying: this.copyStarted !== undefined,
      pendingPairs: this.pendingPairs,
      activePairs: this.activePairs,
      usedBytes: this.usedBytes,
      maxBytes: this.options.maxBytes,
      copyBytes: this.copyBytes,
      copyMilliseconds:
        this.copyMilliseconds + (this.copyStarted === undefined ? 0 : performance.now() - this.copyStarted),
    };
  }

  /** Flattened pair endpoints. Duplicate occurrences count as separate remaining uses. */
  plan(paths: string[]): void {
    if (this.closed || this.planned) throw new Error('Media staging may be planned once.');
    for (const originalPath of paths) {
      if (!path.isAbsolute(originalPath)) throw new Error('Media source paths must be absolute.');
      if (inside(this.options.cacheRoot, originalPath))
        throw new Error('Source media cannot be inside the private cache.');
      const id = key(originalPath);
      const record = this.records.get(id) ?? {
        originalPath: path.resolve(originalPath),
        refs: 0,
        active: 0,
        lastUsed: 0,
        retired: new Set<string>(),
      };
      record.refs++;
      this.records.set(id, record);
    }
    this.planned = true;
  }

  withPair<T>(
    paths: [string, string],
    signal: AbortSignal,
    callback: (
      localPaths: [string, string],
      trustedLocalIdentities: [string, string],
      trustedOriginalIdentities: [string, string],
    ) => Promise<T>,
  ): Promise<T> {
    if (this.closed || !this.planned) return Promise.reject(new Error('Media staging is not available.'));
    const records = paths.map((file) => this.records.get(key(file)));
    if (records.some((record) => !record || record.refs <= 0)) {
      return Promise.reject(new Error('Media pair was not included in the staging plan.'));
    }
    const entries = records as [RecordEntry, RecordEntry];
    for (const entry of entries) entry.active++;
    this.activePairs++;
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    const operation = (async () => {
      let verified = false;
      try {
        throwIfAborted(combined);
        // Fully staged pairs need no copy, capacity reservation or ownership mutation. Let them
        // decode while an unrelated source copy holds the serial gate. Active references above
        // protect the snapshots from deletion; changed or retired copies use the normal slow path.
        const selections =
          (await this.readySelections(entries, combined)) ?? (await this.selectPair(entries, combined));
        throwIfAborted(combined);
        await this.checkSelections(selections);
        const identities = selections.map((selection) => {
          const local = selection.localStamp;
          return [local.dev, local.ino, local.size, local.mtimeNs, local.ctimeNs].join(':');
        }) as [string, string];
        const originalIdentities = selections.map((selection) => {
          const original = selection.originalStamp;
          return [original.dev, original.ino, original.size, original.mtimeNs, original.ctimeNs].join(':');
        }) as [string, string];
        const result = await callback(
          [selections[0].localPath, selections[1].localPath],
          identities,
          originalIdentities,
        );
        throwIfAborted(combined);
        await this.checkSelections(selections);
        verified = true;
        return result;
      } finally {
        for (const entry of entries) entry.active--;
        this.activePairs--;
        // Source/copy identities are already rechecked. Consume references now, but let completed
        // verification publish and claim another pair while unrelated copying delays owned cleanup.
        // Failures still join their cleanup; close joins all deferred cleanup before removing files.
        const cleanup = this.finishPair(paths);
        if (verified && this.selectingPair) this.deferCleanup(cleanup);
        else await cleanup;
      }
    })();
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }

  private selectPair(entries: [RecordEntry, RecordEntry], signal: AbortSignal): Promise<[Selection, Selection]> {
    this.pendingPairs++;
    return this.serial(async () => {
      this.pendingPairs--;
      this.selectingPair = true;
      try {
        const first = await this.select(entries[0], signal);
        const second = await this.select(entries[1], signal);
        return [first, second];
      } finally {
        this.selectingPair = false;
      }
    });
  }

  private deferCleanup(cleanup: Promise<void>): void {
    this.pendingCleanups.add(cleanup);
    void cleanup.then(
      () => this.pendingCleanups.delete(cleanup),
      () => {
        this.pendingCleanups.delete(cleanup);
        this.note('媒体临时目录暂未清理，原始文件不受影响。');
      },
    );
  }

  /** Consume a cached/prechecked pair that did not enter withPair. */
  async finishPair(paths: readonly string[]): Promise<void> {
    for (const file of paths) {
      const record = this.records.get(key(file));
      if (record) record.refs = Math.max(0, record.refs - 1);
    }
    await this.serial(async () => {
      for (const record of new Set(paths.map((file) => this.records.get(key(file))))) {
        if (!record || record.active !== 0) continue;
        for (const name of record.retired) {
          const owned = this.owned.get(name);
          if (owned) await this.deleteFile(owned);
        }
        record.retired.clear();
        if (record.refs === 0) await this.evict(record);
      }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort(new Error('Media staging closed.'));
    this.closing = (async () => {
      await Promise.allSettled([...this.operations]);
      await Promise.allSettled([...this.pendingCleanups]);
      await this.serial(async () => {
        if (!this.directory || !this.marker || !(await directoryMatches(this.directory, this.marker))) return;
        for (const owned of [...this.owned.values()]) await this.deleteFile(owned);
        if (this.owned.size === 0) await this.removeEmptyNamespace();
      });
    })();
    return this.closing;
  }

  /** Clean only positively identified app-created files from dead-owner namespaces. */
  static async cleanupStale(cacheRoot: string, note?: (message: string) => void): Promise<void> {
    let root: string;
    try {
      root = await safeRoot(cacheRoot, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of await readdir(root)) {
      const match = NAMESPACE.exec(name);
      if (!match) continue;
      const directory = path.join(root, name);
      try {
        const directoryStats = await lstat(directory);
        if (
          !directoryStats.isDirectory() ||
          directoryStats.isSymbolicLink() ||
          key(await realpath(directory)) !== key(directory)
        ) {
          continue;
        }
        const markerPath = path.join(directory, MARKER);
        const markerStats = await lstat(markerPath);
        if (!markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.size > 1_048_576) continue;
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Marker;
        if (
          marker.format !== FORMAT ||
          marker.token !== match[1] ||
          marker.directory !== name ||
          key(marker.cacheRoot) !== key(root) ||
          !Number.isSafeInteger(marker.ownerPid) ||
          marker.ownerPid <= 0 ||
          !Array.isArray(marker.files) ||
          marker.files.some(
            (file) =>
              !ASSET.test(file.name) ||
              !/^\d+$/.test(file.dev) ||
              !/^\d+$/.test(file.ino) ||
              !Number.isSafeInteger(file.size) ||
              file.size < 0,
          ) ||
          !(await directoryMatches(directory, marker))
        ) {
          continue;
        }
        try {
          process.kill(marker.ownerPid, 0);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
        for (const file of marker.files) {
          if (!(await directoryMatches(directory, marker))) break;
          await removeOwned(directory, file);
        }
        if (!(await directoryMatches(directory, marker))) continue;
        const remaining = await readdir(directory);
        if (remaining.length === 1 && remaining[0] === MARKER) {
          await unlink(markerPath);
          await rmdir(directory);
        }
      } catch {
        note?.('遗留媒体临时文件暂未清理，原始文件不受影响。');
      }
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work, work);
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private note(message: string): void {
    if (this.notes.has(message)) return;
    this.notes.add(message);
    try {
      this.options.note?.(message);
    } catch {
      // A display callback must not interrupt verification or cleanup.
    }
  }

  private async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const root = await safeRoot(this.options.cacheRoot, true);
      await LocalMediaStagingCache.cleanupStale(root, (message) => this.note(message));
      const token = randomUUID();
      const name = `pugport-media-${token}`;
      const directory = path.join(root, name);
      await mkdir(directory);
      const stats = await lstat(directory, { bigint: true });
      this.directory = directory;
      this.marker = {
        format: FORMAT,
        token,
        ownerPid: process.pid,
        cacheRoot: root,
        directory: name,
        dev: String(stats.dev),
        ino: String(stats.ino),
        files: [],
      };
      await this.writeMarker();
    })();
    return this.initialization;
  }

  private async writeMarker(): Promise<void> {
    if (!this.directory || !this.marker || !(await directoryMatches(this.directory, this.marker))) {
      throw new Error('Media cache ownership changed.');
    }
    this.marker.files = [...this.owned.values()];
    const temporary = path.join(this.directory, `${MARKER}.tmp`);
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify(this.marker), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path.join(this.directory, MARKER));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async fallback(record: RecordEntry): Promise<Selection> {
    const originalStamp = await fileStamp(record.originalPath);
    return {
      originalPath: record.originalPath,
      originalStamp,
      localPath: record.originalPath,
      localStamp: originalStamp,
    };
  }

  private async readySelections(
    records: [RecordEntry, RecordEntry],
    signal: AbortSignal,
  ): Promise<[Selection, Selection] | undefined> {
    throwIfAborted(signal);
    const ready = records.map((record) => record.ready);
    if (!ready[0] || !ready[1]) return;
    const snapshots = ready as [ReadyFile, ReadyFile];
    try {
      const selections = (await Promise.all(
        records.map(async (record, index) => {
          const snapshot = snapshots[index]!;
          const [originalStamp, localStamp] = await Promise.all([
            fileStamp(record.originalPath),
            fileStamp(snapshot.localPath),
          ]);
          if (!equalStamp(originalStamp, snapshot.originalStamp) || !equalStamp(localStamp, snapshot.localStamp))
            return;
          return {
            originalPath: record.originalPath,
            originalStamp,
            localPath: snapshot.localPath,
            localStamp,
          };
        }),
      )) as [Selection | undefined, Selection | undefined];
      throwIfAborted(signal);
      if (!selections[0] || !selections[1] || records.some((record, index) => record.ready !== snapshots[index]))
        return;
      for (const record of records) record.lastUsed = Date.now();
      return selections as [Selection, Selection];
    } catch {
      throwIfAborted(signal);
      // A missing, modified or replaced copy is rechecked under the existing serial gate.
      return;
    }
  }

  private async select(record: RecordEntry, signal: AbortSignal): Promise<Selection> {
    throwIfAborted(signal);
    record.lastUsed = Date.now();
    const originalStamp = await fileStamp(record.originalPath);
    if (record.ready) {
      const ready = record.ready;
      try {
        if (
          equalStamp(originalStamp, ready.originalStamp) &&
          equalStamp(await fileStamp(ready.localPath), ready.localStamp)
        ) {
          return {
            originalPath: record.originalPath,
            originalStamp,
            localPath: ready.localPath,
            localStamp: ready.localStamp,
          };
        }
      } catch {
        // Changed copies cannot be reused.
      }
      await this.evict(record);
    }
    if (record.timedOutStamp) {
      if (equalStamp(originalStamp, record.timedOutStamp)) return this.fallback(record);
      record.timedOutStamp = undefined;
    }
    if (originalStamp.size > this.options.maxBytes) {
      this.note('单份媒体超过 SSD 临时缓存上限，使用原文件只读核验。');
      return this.fallback(record);
    }
    // Admission concerns only cold copies. Ready copies above were already reused, and original
    // verification is unchanged. With no measured stream, retain the existing first-attempt policy.
    const observedRate = this.successfulCopyRates.length ? Math.min(...this.successfulCopyRates) : undefined;
    if (observedRate !== undefined && originalStamp.size / observedRate >= this.options.copyTimeoutMs * 0.75) {
      return this.fallback(record);
    }
    try {
      await this.initialize();
      throwIfAborted(signal);
      const needed = originalStamp.size;
      const available =
        this.options.spaceAvailable ??
        (async (root: string) => {
          const stats = await statfs(root, { bigint: true });
          return Number(stats.bavail * stats.bsize);
        });
      const inactive = [...this.records.values()]
        .filter((entry) => entry.active === 0 && entry.ready)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      let free = await available(this.options.cacheRoot);
      if (!Number.isFinite(free) || free < 0) throw new Error('Media cache volume availability was not reported.');
      for (const entry of inactive) {
        if (this.usedBytes + needed <= this.options.maxBytes && free - needed >= this.options.minFreeBytes) break;
        await this.evict(entry);
        free = await available(this.options.cacheRoot);
        if (!Number.isFinite(free) || free < 0) throw new Error('Media cache volume availability was not reported.');
      }
      if (this.usedBytes + needed > this.options.maxBytes || free - needed < this.options.minFreeBytes) {
        this.note('SSD 临时缓存空间不足，使用原文件只读核验。');
        return this.fallback(record);
      }
      return await this.copy(record, originalStamp, signal);
    } catch (error) {
      throwIfAborted(signal);
      this.note('SSD 临时复制未完成，使用原文件只读核验。');
      return this.fallback(record);
    }
  }

  private async copy(record: RecordEntry, originalStamp: Stamp, signal: AbortSignal): Promise<Selection> {
    const directory = this.directory!;
    const extension = path.extname(record.originalPath).toLowerCase();
    const name = `asset-${randomUUID()}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`;
    const target = path.join(directory, name);
    const sourceHandle = await open(record.originalPath, 'r');
    let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
    let reader: Readable | undefined;
    let writer: Writable | undefined;
    let owned: OwnedFile | undefined;
    const timeout = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let streamedMilliseconds = 0;
    try {
      if (!equalStamp(stamp(await sourceHandle.stat({ bigint: true })), originalStamp))
        throw new MediaStagingChangedError();
      if (!this.marker || !(await directoryMatches(directory, this.marker))) throw new MediaStagingChangedError();
      targetHandle = await open(target, 'wx');
      const targetStats = await targetHandle.stat({ bigint: true });
      owned = { name, dev: String(targetStats.dev), ino: String(targetStats.ino), size: originalStamp.size };
      this.owned.set(name, owned);
      this.usedBytes += owned.size;
      await this.writeMarker();
      const timeoutReason = new Error('Media staging copy timed out.');
      if (this.options.copyTimeoutMs === 0) timeout.abort(timeoutReason);
      else {
        timer = setTimeout(() => timeout.abort(timeoutReason), this.options.copyTimeoutMs);
        timer.unref();
      }
      const copySignal = AbortSignal.any([signal, timeout.signal]);
      reader = sourceHandle.createReadStream({ autoClose: false, emitClose: false, highWaterMark: 1024 * 1024 });
      writer = targetHandle.createWriteStream({ autoClose: false, emitClose: false, highWaterMark: 1024 * 1024 });
      const countBytes = (chunk: Buffer) => {
        this.copyBytes += chunk.length;
      };
      this.copyStarted = performance.now();
      reader.on('data', countBytes);
      try {
        await pipeline(reader, writer, { signal: copySignal });
      } finally {
        streamedMilliseconds = performance.now() - this.copyStarted;
        this.copyMilliseconds += streamedMilliseconds;
        this.copyStarted = undefined;
        reader.removeListener('data', countBytes);
      }
      throwIfAborted(copySignal);
      if (
        !equalStamp(stamp(await sourceHandle.stat({ bigint: true })), originalStamp) ||
        !equalStamp(await fileStamp(record.originalPath), originalStamp)
      ) {
        throw new MediaStagingChangedError();
      }
      await targetHandle.utimes(new Date(), Number(BigInt(originalStamp.mtimeNs)) / 1e9);
      const localStamp = stamp(await targetHandle.stat({ bigint: true }));
      if (localStamp.size !== originalStamp.size || !equalStamp(await fileStamp(target), localStamp)) {
        throw new MediaStagingChangedError();
      }
      throwIfAborted(copySignal);
      record.ready = { localPath: target, originalStamp, localStamp };
      if (originalStamp.size >= 1024 * 1024 && streamedMilliseconds > 0) {
        this.successfulCopyRates.push(originalStamp.size / streamedMilliseconds);
        if (this.successfulCopyRates.length > 4) this.successfulCopyRates.shift();
      }
      return { originalPath: record.originalPath, originalStamp, localPath: target, localStamp };
    } catch (error) {
      if (timeout.signal.aborted && !signal.aborted) record.timedOutStamp = originalStamp;
      reader?.destroy();
      writer?.destroy();
      await Promise.allSettled([sourceHandle.close(), targetHandle?.close()]);
      targetHandle = undefined;
      if (owned) await this.deleteFile(owned);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      reader?.destroy();
      writer?.destroy();
      await Promise.allSettled([sourceHandle.close(), targetHandle?.close()]);
    }
  }

  private async checkSelections(selections: Selection[]): Promise<void> {
    for (const selected of selections) {
      try {
        if (
          !equalStamp(await fileStamp(selected.originalPath), selected.originalStamp) ||
          !equalStamp(await fileStamp(selected.localPath), selected.localStamp)
        ) {
          throw new MediaStagingChangedError();
        }
      } catch {
        throw new MediaStagingChangedError();
      }
    }
  }

  private async evict(record: RecordEntry): Promise<void> {
    const ready = record.ready;
    if (!ready) return;
    record.ready = undefined;
    const name = path.basename(ready.localPath);
    if (record.active > 0) {
      record.retired.add(name);
      return;
    }
    const owned = this.owned.get(name);
    if (owned) await this.deleteFile(owned);
  }

  private async deleteFile(owned: OwnedFile): Promise<void> {
    if (!this.directory || !this.marker || !(await directoryMatches(this.directory, this.marker))) return;
    if (await removeOwned(this.directory, owned)) {
      this.owned.delete(owned.name);
      this.usedBytes = Math.max(0, this.usedBytes - owned.size);
      try {
        await this.writeMarker();
      } catch {
        this.note('媒体临时缓存清理记录暂未更新。');
      }
    } else {
      this.note('媒体临时文件正在使用或已变化，稍后清理。');
    }
  }

  private async removeEmptyNamespace(): Promise<void> {
    const directory = this.directory!;
    try {
      const entries = await readdir(directory);
      if (entries.length !== 1 || entries[0] !== MARKER) return;
      await unlink(path.join(directory, MARKER));
      await rmdir(directory);
    } catch {
      this.note('媒体临时目录暂未清理，原始文件不受影响。');
    }
  }
}
