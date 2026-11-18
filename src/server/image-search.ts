import { isMainThread } from 'node:worker_threads';
import { runImageSearchWorker, stopImageSearchWorker, imageWorkerStatus } from './image-search-client.ts';
import { isolatedUserPath, underTest } from './platform/under-test.ts';
import { trackBusy } from './backend-activity.ts';
import { execFile } from './platform/test-process.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  beginPicturePass,
  embedImagesInWorker,
  embedTextInWorker,
  modelProvider,
  readTextInWorker,
  matchQuery,
  prepareQuery,
  releaseQuery,
  sourceThreshold,
  stopMatchWorker,
  sureSource,
} from './image-match.ts';
import { ripgrep, skippedFoldersBelow } from './local-tools.ts';
import { ocrModelDirectory } from './ocr.ts';
import { dateRange, exifCaptureTime, inRange, type DateRange } from './photo-date.ts';
import { runtimeDirectories } from '../../scripts/runtime-paths.mjs';
import { appDirs, userFolders } from './platform/dirs.ts';
import { currentHost, type Host } from './platform/host.ts';
import { onBattery as systemOnBattery } from './platform/system-stats.ts';

/*
 * Image search on this computer, in layers:
 *  1. the same file under another name or place (size, then SHA-256);
 *  2. the same picture resized, recompressed, re-screenshotted or lightly cropped (a 64-bit difference hash);
 *  3. the picture a partial screenshot was taken from (keypoint matching, image-match.ts), checked on the
 *     likeliest candidates first;
 *  4. pictures with similar content, and pictures matching a description (Chinese-CLIP ViT-B/16, run locally
 *     with ONNX Runtime; scripts/setup-image-search.mjs fetches it).
 * What it learns about each picture is kept in a private index, so a later search only reads new or changed
 * files. Nothing leaves the computer. Files that are only in the cloud (OneDrive placeholders) are skipped
 * rather than downloaded.
 */

const run = promisify(execFile);
export const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'avif'];
const imagePattern = new RegExp(`\\.(${imageExtensions.join('|')})$`, 'i');
const minBytes = 4 * 1024;
const maxBytes = 200 * 1024 * 1024;
const maxListed = 60_000;
const side = 224;
const dims = 512;

export function imageModelDirectory(appRoot: string): string | undefined {
  // Development keeps it in .runtime/image-search; a packaged app in resources/image-search.
  return runtimeDirectories(appRoot, 'image-search').find(
    (dir) => existsSync(join(dir, 'model.onnx')) && existsSync(join(dir, 'vocab.txt')),
  );
}

export function imageIndexDirectory(): string {
  const dir = process.env.COMBORUNNER_IMAGE_INDEX_DIR || appDirs().imageIndex;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The folders searched when none are named: where people keep pictures, screenshots and downloads. */
export function defaultImageFolders(home?: string, host: Host = currentHost()): string[] {
  const { path } = host;
  const at = host === currentHost() ? isolatedUserPath(home ?? host.home) : (home ?? host.home);
  let candidates: string[];
  if (host.platform === 'win32') {
    const names = ['Pictures', 'Desktop', 'Downloads', 'Documents', 'Videos'];
    const roots = [at, path.join(at, 'OneDrive')];
    candidates = roots.flatMap((root) => names.map((name) => path.join(root, name)));
  } else {
    // macOS Movies instead of Videos; Linux names from xdg-user-dirs, which may be localized (图片, 下载, …).
    const folders = userFolders({ ...host, home: at });
    candidates = [folders.pictures, folders.desktop, folders.downloads, folders.documents, folders.videos];
  }
  return dedupeFolders(
    candidates.filter((dir) => host.fs.existsSync(dir)),
    host,
  );
}

/** Drops folders inside another listed folder. */
export function dedupeFolders(folders: string[], host: Host = currentHost()): string[] {
  const { isAbsolute, relative, resolve, sep } = host.path;
  const sorted = [...new Set(folders.map((folder) => resolve(folder)))].sort((a, b) => a.length - b.length);
  return sorted.filter(
    (folder, index) =>
      !sorted.slice(0, index).some((parent) => {
        // The platform's relative paths preserve Windows case folding and POSIX case sensitivity.
        const child = relative(parent, folder);
        return !child || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
      }),
  );
}

// ——— Picture analysis ———

type Sharp = (
  input: string | Buffer,
  options?: Record<string, unknown>,
) => {
  rotate(): ReturnType<Sharp>;
  removeAlpha(): ReturnType<Sharp>;
  toColourspace(space: string): ReturnType<Sharp>;
  resize(width: number, height: number, options?: Record<string, unknown>): ReturnType<Sharp>;
  raw(): ReturnType<Sharp>;
  metadata(): Promise<{ exif?: Buffer }>;
  toBuffer(options: {
    resolveWithObject: true;
  }): Promise<{ data: Buffer; info: { channels: number; width: number; height: number } }>;
};
let sharpModule: Sharp | undefined;
function sharp(): Sharp {
  if (!sharpModule) {
    const loaded = createRequire(import.meta.url)('sharp') as Sharp & {
      concurrency(n: number): void;
      cache(enabled: boolean): void;
    };
    // A single picture decode uses two libvips threads; batch members decode sequentially.
    loaded.concurrency(2);
    loaded.cache(false);
    sharpModule = loaded;
  }
  return sharpModule;
}

/** Decodes once to 224×224 RGB: the model's input, and the source of the difference hash. */
async function pixels(path: string): Promise<Buffer> {
  const { data, info } = await sharp()(path, { failOn: 'none', limitInputPixels: 40_000_000, pages: 1 })
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .resize(side, side, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || data.length !== side * side * 3) throw new Error('Unexpected image layout.');
  return data;
}

/** When the photo was taken (EXIF), or null when the picture does not say. */
async function captureTime(path: string): Promise<number | null> {
  return sharp()(path, { failOn: 'none' })
    .metadata()
    .then((metadata) => exifCaptureTime(metadata.exif) ?? null)
    .catch(() => null);
}

/** Decode batch members one at a time so large source images never inflate a batch's native memory. */
export async function decodePictureBatch(
  paths: string[],
  decode: (path: string) => Promise<Buffer> = pixels,
  date: (path: string) => Promise<number | null> = captureTime,
) {
  const results: Array<{ rgb: Buffer; taken: number | null } | undefined> = [];
  for (const path of paths) {
    const rgb = await decode(path).catch(() => undefined);
    const taken = await date(path);
    results.push(rgb ? { rgb, taken } : undefined);
  }
  return results;
}

/**
 * Grey pixels for keypoint matching, at most `longest` pixels on the long side. Never enlarged: upscaling a
 * small screenshot invents texture that matches unrelated pictures.
 */
async function greyPixels(path: string, longest: number) {
  const { data, info } = await sharp()(path, { failOn: 'none', limitInputPixels: 120_000_000, pages: 1 })
    .rotate()
    .removeAlpha()
    .toColourspace('b-w')
    .resize(longest, longest, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || !info.width || !info.height) throw new Error('Unexpected image layout.');
  return { data, width: info.width, height: info.height };
}

/** 9×8 grey cells compared left to right: 64 bits, robust to scaling and recompression. */
export function differenceHash(rgb: Buffer, size = side): string {
  const cols = 9,
    rows = 8;
  const grey = new Float64Array(cols * rows);
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor((col * size) / cols),
        x1 = Math.floor(((col + 1) * size) / cols);
      const y0 = Math.floor((row * size) / rows),
        y1 = Math.floor(((row + 1) * size) / rows);
      let sum = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * size + x) * 3;
          sum += 0.299 * rgb[i]! + 0.587 * rgb[i + 1]! + 0.114 * rgb[i + 2]!;
        }
      grey[row * cols + col] = sum / ((x1 - x0) * (y1 - y0));
    }
  let bits = 0n;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols - 1; col++)
      bits = (bits << 1n) | (grey[row * cols + col]! > grey[row * cols + col + 1]! ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`),
    count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ——— The model ———

/** Remembers which graphics card ran the model fastest (see image-match-worker.ts). */
/** Where the picture model remembers the graphics card it chose; other local models use the same card. */
export const imageGpuFile = () => join(imageIndexDirectory(), 'gpu.json');
const gpuFile = imageGpuFile;

// The model itself loads and runs in the worker thread (image-match-worker.ts); only its vocabulary is here.
let vocabulary: { dir: string; vocab: Map<string, number> } | undefined;
function loadVocabulary(dir: string): Map<string, number> {
  if (vocabulary?.dir !== dir) {
    const vocab = new Map<string, number>();
    readFileSync(join(dir, 'vocab.txt'), 'utf8')
      .split(/\r?\n/)
      .forEach((token, index) => token && !vocab.has(token) && vocab.set(token, index));
    vocabulary = { dir, vocab };
  }
  return vocabulary.vocab;
}

const mean = [0.48145466, 0.4578275, 0.40821073];
const std = [0.26862954, 0.26130258, 0.27577711];
function normalizeInto(rgb: Buffer, out: Float32Array, offset: number) {
  const plane = side * side;
  for (let i = 0; i < plane; i++)
    for (let c = 0; c < 3; c++) out[offset + c * plane + i] = (rgb[i * 3 + c]! / 255 - mean[c]!) / std[c]!;
}

function unit(values: Float32Array): Float32Array {
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return values.map((value) => value / norm);
}

/** BERT basic + WordPiece tokenization (Chinese-CLIP's text side): CJK characters are tokens of their own. */
export function tokenize(text: string, vocab: Map<string, number>, maxLength = 52): number[] {
  const cjk = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]/u;
  const spaced = Array.from(text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))
    .map((char) => (cjk.test(char) || /[\p{P}\p{S}]/u.test(char) ? ` ${char} ` : char))
    .join('');
  const ids = [vocab.get('[CLS]') ?? 101];
  const unknown = vocab.get('[UNK]') ?? 100;
  for (const word of spaced.split(/\s+/).filter(Boolean)) {
    if (word.length > 100) {
      ids.push(unknown);
      continue;
    }
    const pieces: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length,
        found: number | undefined;
      for (; end > start; end--) {
        const piece = (start > 0 ? '##' : '') + word.slice(start, end);
        found = vocab.get(piece);
        if (found !== undefined) break;
      }
      if (found === undefined) {
        pieces.length = 0;
        pieces.push(unknown);
        break;
      }
      pieces.push(found);
      start = end;
    }
    ids.push(...pieces);
  }
  return [...ids.slice(0, maxLength - 1), vocab.get('[SEP]') ?? 102];
}

/** The model has one graph for both sides; the unused side gets the smallest valid input. */
async function embedPictures(appRoot: string, pictures: Buffer[]): Promise<Float32Array[]> {
  const dir = imageModelDirectory(appRoot);
  if (!dir || !pictures.length) return [];
  const plane = 3 * side * side;
  const input = new Float32Array(pictures.length * plane);
  pictures.forEach((rgb, index) => normalizeInto(rgb, input, index * plane));
  const data = await embedImagesInWorker(dir, input, pictures.length, gpuFile());
  return pictures.map((_, index) => unit(data.slice(index * dims, (index + 1) * dims)));
}

async function embedText(appRoot: string, text: string): Promise<Float32Array | undefined> {
  const dir = imageModelDirectory(appRoot);
  if (!dir) return undefined;
  const data = await embedTextInWorker(dir, tokenize(text, loadVocabulary(dir)), gpuFile());
  return unit(data.slice(0, dims));
}

const toBytes = (vector: Float32Array) => Int8Array.from(vector, (value) => Math.round(value * 127));
function cosine(a: Int8Array | Float32Array, b: Int8Array | Float32Array, scaleA: number, scaleB: number) {
  let dot = 0;
  for (let i = 0; i < dims; i++) dot += a[i]! * b[i]!;
  return dot / (scaleA * scaleB);
}

// ——— The index ———

type Entry = {
  path: string;
  size: number;
  mtime: number;
  hash?: string;
  vector?: Int8Array;
  failed?: boolean;
  /** Text read from the picture (screenshots and documents only); `read` marks pictures already looked at. */
  text?: string;
  read?: boolean;
  /** When it was taken (EXIF, seconds); null: the picture has no capture date; missing: not read yet. */
  taken?: number | null;
};
type Saved = { version: 1; entries: Array<Omit<Entry, 'vector'> & { v?: number }>; folders: string[] };

export class ImageIndex {
  entries = new Map<string, Entry>();
  /** Folders searched before; the background pass keeps them current. */
  folders: string[] = [];
  private dirty = 0;
  private vectors = new Int8Array(0);
  private vectorCount = 0;
  private saving: Promise<void> | undefined;
  constructor(readonly directory: string) {
    const end = trackBusy('image-index');
    try {
      const saved = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')) as Saved;
      const bytes = readFileSync(join(directory, 'vectors.bin'));
      const vectors = (this.vectors = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      this.vectorCount = Math.floor(vectors.length / dims);
      if (saved.version !== 1) return;
      this.folders = saved.folders ?? [];
      for (const { v, ...entry } of saved.entries)
        this.entries.set(entry.path.toLowerCase(), {
          ...entry,
          ...(v !== undefined && Number.isSafeInteger(v) && v >= 0 && (v + 1) * dims <= vectors.length
            ? { vector: vectors.subarray(v * dims, (v + 1) * dims) }
            : {}),
        });
    } catch {
      /* A new or unreadable index starts empty. */
    } finally {
      end();
    }
  }
  async set(entry: Entry) {
    while (this.saving) await this.saving;
    const key = entry.path.toLowerCase();
    const previous = this.entries.get(key)?.vector;
    if (entry.vector) {
      const offset = previous ? previous.byteOffset - this.vectors.byteOffset : this.vectorCount++ * dims;
      if (offset + dims > this.vectors.length) {
        const grown = new Int8Array(Math.max(offset + dims, Math.ceil((this.vectors.length * 1.25) / dims) * dims));
        grown.set(this.vectors);
        for (const existing of this.entries.values()) {
          if (!existing.vector) continue;
          const start = existing.vector.byteOffset - this.vectors.byteOffset;
          existing.vector = grown.subarray(start, start + dims);
        }
        this.vectors = grown;
      }
      this.vectors.set(entry.vector, offset);
      entry.vector = this.vectors.subarray(offset, offset + dims);
    }
    this.entries.set(key, entry);
  }
  touch() {
    this.dirty++;
  }
  async save(force = false) {
    if (!this.dirty || (!force && this.dirty < 2000)) return;
    const end = trackBusy('image-index');
    try {
      return await this.saveImpl(force);
    } finally {
      end();
    }
  }
  private async saveImpl(force: boolean) {
    if (!this.dirty || (!force && this.dirty < 2000)) return;
    while (this.saving) await this.saving;
    if (!this.dirty || (!force && this.dirty < 2000)) return;
    const dirty = this.dirty;
    this.dirty = 0;
    const entries: Saved['entries'] = [];
    for (const { vector, ...entry } of this.entries.values()) {
      const saved: Saved['entries'][number] = entry;
      if (vector) saved.v = (vector.byteOffset - this.vectors.byteOffset) / dims;
      entries.push(saved);
    }
    const bytes = this.vectors.subarray(0, this.vectorCount * dims);
    const folders = JSON.stringify(this.folders);
    const saving = (async () => {
      const index = join(this.directory, 'index.json'),
        bin = join(this.directory, 'vectors.bin');
      await writeFile(`${bin}.tmp`, bytes);
      const file = await open(`${index}.tmp`, 'w');
      try {
        await file.writeFile('{"version":1,"entries":[');
        for (let start = 0; start < entries.length; start += 2000) {
          const chunk = Buffer.from(JSON.stringify(entries.slice(start, start + 2000)));
          if (start) await file.writeFile(',');
          await file.writeFile(chunk.subarray(1, -1));
        }
        await file.writeFile(`],"folders":${folders}}`);
      } finally {
        await file.close();
      }
      await rename(`${bin}.tmp`, bin);
      await rename(`${index}.tmp`, index);
    })().catch(() => {
      this.dirty += dirty;
    });
    this.saving = saving;
    try {
      await saving;
    } finally {
      if (this.saving === saving) this.saving = undefined;
    }
  }
}
let index: ImageIndex | undefined;
const theIndex = () => (index ??= new ImageIndex(imageIndexDirectory()));

/** Lets tests point the index at a fresh directory, or read the saved searches again as after a restart. */
export function resetImageIndex() {
  if (isMainThread) stopImageSearchWorker();
  index = undefined;
}
export function reloadImageSearches() {
  if (loaded) saveSearchesNow();
  for (const search of searches.values()) search.run?.abort.abort();
  searches.clear();
  loaded = false;
  shuttingDown = false;
  loadSearches();
}

type Listed = { path: string; size: number; mtime: number };
/**
 * Picture files under the folders, using the local folder walk. Cloud-only OneDrive files are left out.
 */
async function listPictures(folders: string[]): Promise<Listed[]> {
  const listed = new Map<string, Listed>();
  for (const folder of folders) {
    if (ignoredImagePath(folder)) continue;
    const rows = await listByWalking(folder);
    for (const row of rows) {
      if (listed.size >= maxListed) break;
      if (
        ignoredImagePath(row.path) ||
        row.cloudOnly ||
        row.size < minBytes ||
        row.size > maxBytes ||
        !imagePattern.test(row.path)
      )
        continue;
      listed.set(row.path.toLowerCase(), { path: row.path, size: row.size, mtime: row.mtime });
    }
  }
  return [...listed.values()];
}

const imageIgnoredFolders = [
  '.oil-ui',
  'artifacts',
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'playwright-report',
  '__screenshots__',
  '__image_snapshots__',
];
export function ignoredImagePath(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]+/);
  return parts.some(
    (part, index) =>
      imageIgnoredFolders.includes(part) ||
      (part === 'worktrees' && parts[index - 1] === '.claude') ||
      (part === 'screenshots' && parts.slice(0, index).some((parent) => ['test', 'tests', 'e2e'].includes(parent))),
  );
}

/** PowerShell on Windows (it sees the cloud-only attributes), ripgrep elsewhere. */
async function listByWalking(folder: string): Promise<Array<Listed & { cloudOnly: boolean }>> {
  if (process.platform === 'win32' && !underTest()) {
    const skipped = [...skippedFoldersBelow(folder), ...imageIgnoredFolders]
      .map((name) => name.replace(/[.$]/g, (char) => `\\${char}`))
      .join('|');
    const script = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      `function Walk($dir) { Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PSIsContainer) { if ($_.Name -notmatch '^(${skipped})$' -and -not ($_.Name -eq 'worktrees' -and (Split-Path $_.Parent.FullName -Leaf) -eq '.claude') -and -not ($_.Name -eq 'screenshots' -and $_.FullName -match '[\\\\/](tests?|e2e)[\\\\/]') -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Walk $_.FullName } } elseif ($_.Extension -match '^\\.(${imageExtensions.join('|')})$') { '{0}|{1}|{2}|{3}' -f $_.Length, [DateTimeOffset]::new($_.LastWriteTimeUtc).ToUnixTimeSeconds(), $_.Attributes.value__, $_.FullName } } }; Walk $env:CR_FOLDER`,
    ].join('; ');
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, CR_FOLDER: folder },
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
    return stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(\d+)\|(-?\d+)\|(\d+)\|(.+)$/);
      return match
        ? [
            {
              path: match[4]!,
              size: Number(match[1]),
              mtime: Number(match[2]),
              cloudOnly: (Number(match[3]) & (0x1000 | 0x40000 | 0x400000)) !== 0,
            },
          ]
        : [];
    });
  }
  const rg = ripgrep();
  if (!rg) return [];
  const { stdout } = await run(
    rg,
    [
      '--files',
      '--hidden',
      '--no-messages',
      '--iglob',
      `*.{${imageExtensions.join(',')}}`,
      ...[
        ...skippedFoldersBelow(folder),
        ...imageIgnoredFolders,
        '.claude/worktrees',
        '**/tests/**/screenshots',
      ].flatMap((name) => ['--iglob', `!${name}/**`]),
    ],
    { cwd: folder, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  const rows: Array<Listed & { cloudOnly: boolean }> = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const path = resolve(folder, line);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) rows.push({ path, size: info.size, mtime: Math.floor(info.mtimeMs / 1000), cloudOnly: false });
  }
  return rows;
}

/** Brings the listed pictures up to date in the index, within a time budget; returns how many remain. */
async function analyze(...args: Parameters<typeof analyzeImpl>): Promise<number> {
  const end = trackBusy('image-index');
  try {
    return await analyzeImpl(...args);
  } finally {
    end();
  }
}
async function analyzeImpl(
  appRoot: string,
  pictures: Listed[],
  options: {
    until: number;
    batch: number;
    pause?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    /** Only pictures inside it are analyzed; a running search narrowed by the user shrinks it. */
    scope?: Scope;
  },
): Promise<number> {
  const store = theIndex();
  const withModel = !!imageModelDirectory(appRoot);
  const pending = pictures.filter((picture) => {
    const entry = store.entries.get(picture.path.toLowerCase());
    if (!entry || entry.size !== picture.size || entry.mtime !== picture.mtime) return true;
    return !entry.failed && withModel && !entry.vector;
  });
  const inScope = (picture: Listed) => !options.scope || within(picture.path, options.scope.folders);
  const processed = new Set<Listed>();
  let version = -1,
    total = 0,
    done = 0;
  const recount = () => {
    version = options.scope?.version ?? 0;
    total = pending.filter(inScope).length;
    done = [...processed].filter(inScope).length;
  };
  recount();
  let cursor = 0;
  const take = () => {
    const batch: Listed[] = [];
    let bytes = 0;
    while (batch.length < Math.min(options.batch, 4) && cursor < pending.length) {
      const picture = pending[cursor]!;
      if (batch.length && bytes + picture.size > 32 * 1024 * 1024) break;
      cursor++;
      if (inScope(picture)) {
        batch.push(picture);
        bytes += picture.size;
      }
    }
    return batch;
  };
  const decode = (batch: Listed[]) => decodePictureBatch(batch.map((picture) => picture.path));
  let batch = take();

  while (batch.length) {
    if (Date.now() > options.until || options.signal?.aborted) break;
    if ((options.scope?.version ?? 0) !== version) recount();
    const results = await decode(batch);

    const decoded: Array<{ picture: Listed; rgb: Buffer; taken: number | null }> = [];
    for (const [i, picture] of batch.entries()) {
      const result = results[i];
      if (result) decoded.push({ picture, ...result });
      else await store.set({ ...picture, failed: true });
    }
    const vectors = withModel
      ? await embedPictures(
          appRoot,
          decoded.map((item) => item.rgb),
        ).catch(() => [])
      : [];
    for (const [i, { picture, rgb, taken }] of decoded.entries()) {
      await store.set({
        ...picture,
        taken,
        hash: differenceHash(rgb),
        ...(vectors[i] ? { vector: toBytes(vectors[i]) } : {}),
      });
    }
    for (const picture of batch) processed.add(picture);
    done += batch.length;
    options.onProgress?.(done, total);
    for (let i = 0; i < batch.length; i++) store.touch();
    await store.save();
    await new Promise((resume) => setTimeout(resume, options.pause ?? 0));
    batch = take();
  }
  await store.save(true);
  return pending.filter((picture) => inScope(picture) && !processed.has(picture)).length;
}

// ——— Text in pictures ———

/** Pictures the model sees as text screenshots or documents (photos score below 0.02). */
let textPrompts: Promise<{ text: Float32Array; doc: Float32Array; photo: Float32Array } | undefined> | undefined;
async function textiness(appRoot: string, vector: Int8Array): Promise<number> {
  textPrompts ??= (async () => {
    const [text, doc, photo] = await Promise.all(
      ['有很多文字的屏幕截图', '一页文档或聊天记录的截图', '一张人物或风景照片'].map((prompt) =>
        embedText(appRoot, prompt),
      ),
    );
    return text && doc && photo ? { text, doc, photo } : undefined;
  })().catch(() => undefined);
  const prompts = await textPrompts;
  if (!prompts) return -1;
  return (
    Math.max(cosine(vector, prompts.text, 127, 1), cosine(vector, prompts.doc, 127, 1)) -
    cosine(vector, prompts.photo, 127, 1)
  );
}

/** Larger pixels than the model's 224 × 224, for reading text. */
async function textPixels(path: string) {
  const { data, info } = await sharp()(path, { failOn: 'none', limitInputPixels: 120_000_000, pages: 1 })
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Reads the text of screenshot-like pictures among `pictures` that have not been read yet, within a time
 * budget; returns how many are left. Photos are skipped (the model tells them apart), so this stays quick.
 */
async function readTexts(
  appRoot: string,
  pictures: Listed[],
  options: {
    until: number;
    signal?: AbortSignal;
    scope?: Scope;
    onProgress?: (done: number, total: number) => void;
    /** Words being looked for: pictures the model already associates with them are read first. */
    phrase?: string;
  },
): Promise<number> {
  const model = imageModelDirectory(appRoot);
  const ocr = model ? ocrModelDirectory(model) : undefined;
  if (!ocr) return 0;
  const store = theIndex();
  const candidates: Entry[] = [];
  for (const picture of pictures) {
    if (options.scope && !within(picture.path, options.scope.folders)) continue;
    const entry = store.entries.get(picture.path.toLowerCase());
    if (!entry?.vector || entry.read || entry.failed) continue;
    if ((await textiness(appRoot, entry.vector)) > 0.02) candidates.push(entry);
    else entry.read = true;
  }
  // The picture model reads a little text itself, enough to put the likeliest screenshots first.
  const phrase = options.phrase ? await embedText(appRoot, options.phrase).catch(() => undefined) : undefined;
  if (phrase) {
    const likeness = new Map(candidates.map((entry) => [entry, cosine(entry.vector!, phrase, 127, 1)]));
    candidates.sort((a, b) => likeness.get(b)! - likeness.get(a)!);
  }
  let done = 0;
  for (const entry of candidates) {
    if (Date.now() > options.until || options.signal?.aborted) break;
    if (options.scope && !within(entry.path, options.scope.folders)) continue;
    const lines = await textPixels(entry.path)
      .then((rgb) => readTextInWorker(ocr, rgb, gpuFile()))
      .catch(() => [] as string[]);
    entry.read = true;
    if (lines.length) entry.text = lines.join('\n').slice(0, 4000);
    store.touch();
    done++;
    options.onProgress?.(done, candidates.length);
    if (done % 20 === 0) await store.save();
  }
  await store.save(true);
  return candidates.length - done;
}

/** Lowercase, no spaces or punctuation: OCR splits and spaces words its own way. */
const squashText = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** Pictures whose text contains the phrase (or every word of it), with the line it was found in. */
function textMatches(entries: Entry[], phrase: string): Array<{ path: string; line: string }> {
  const whole = squashText(phrase);
  const words = phrase.split(/\s+/).map(squashText).filter(Boolean);
  if (!whole) return [];
  const found: Array<{ path: string; line: string; exact: boolean }> = [];
  for (const entry of entries) {
    if (!entry.text) continue;
    const flat = squashText(entry.text);
    const exact = flat.includes(whole);
    if (!exact && !(words.length > 1 && words.every((word) => flat.includes(word)))) continue;
    const lines = entry.text.split('\n');
    const line = lines.find((item) => squashText(item).includes(exact ? whole : words[0]!)) ?? lines[0]!;
    found.push({ path: entry.path, line: line.slice(0, 120), exact });
  }
  return found.sort((a, b) => Number(b.exact) - Number(a.exact)).map(({ path, line }) => ({ path, line }));
}

// ——— Searching ———

type Match = { path: string; score: number };
type Source = { path: string; points: number };
export type Params = {
  reference: string;
  description: string;
  /** Words that appear in the picture (read from screenshots and documents). */
  contains?: string;
  folders: string[];
  limit: number;
  withModel: boolean;
  /** Only pictures taken (or, without a capture date, modified) in this range. */
  taken?: DateRange;
};
export type Outcome = {
  params: Params;
  total: number;
  analyzed: number;
  remaining: number;
  checked: number;
  unchecked: number;
  same: string[];
  near: Match[];
  sources: Source[];
  similar: Match[];
  /** Pictures whose text contains the phrase, and how many screenshot-like pictures are still unread. */
  texts: Array<{ path: string; line: string }>;
  unread: number;
};
export type Budget = { analyzeUntil: number; matchFor: number; matchLimit: number; readUntil?: number };
/** The folders a search covers; a running search is narrowed in place (`version` counts the changes). */
export type Scope = { folders: string[]; version: number };
/** What a conversation's search for one picture has already done, so narrowing or moving it never redoes work. */
export type Memory = { params: Params; checked: Set<string>; sources: Source[] };
function within(path: string, folders: string[]): boolean {
  const lower = path.toLowerCase();
  return folders.some((folder) => {
    const base = folder.toLowerCase().replace(/[\\/]+$/, '');
    return lower === base || lower.startsWith(`${base}\\`) || lower.startsWith(`${base}/`);
  });
}
export type Progress = (phase: 'analyze' | 'match' | 'read', done: number, total: number) => void;
const percent = (score: number) => `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
const sureOf = (outcome: Outcome) => outcome.sources.some((source) => source.points >= sureSource);
let searching = 0;

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
}

async function readParams(args: Record<string, unknown>, appRoot: string): Promise<Params> {
  const reference = typeof args.image === 'string' ? args.image.trim() : '';
  const description = typeof args.text === 'string' ? args.text.trim().slice(0, 200) : '';
  const contains = typeof args.contains === 'string' ? args.contains.trim().slice(0, 200) : '';
  const taken = dateRange(args.from, args.to);
  if (!reference && !description && !contains && !taken)
    throw new Error(
      '请用 image 给出参考图片的完整路径，用 text 描述要找的图片，用 contains 给出图里的文字，或用 from/to 给出拍摄时间。',
    );
  if (reference && !isAbsolute(reference)) throw new Error('image 需要图片的完整路径。');
  const named = stringList(args.folders ?? args.folder);
  for (const folder of named) {
    if (!isAbsolute(folder)) throw new Error(`folders 需要完整路径：${folder}`);
    if (!(await stat(folder).catch(() => undefined))?.isDirectory()) throw new Error(`文件夹不存在：${folder}`);
  }
  const folders = named.length ? dedupeFolders(named) : defaultImageFolders();
  if (!folders.length) throw new Error('没有可搜索的文件夹，请用 folders 指定。');
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(5, Math.min(Math.floor(args.limit), 60))
      : 30;
  const withModel = !!imageModelDirectory(appRoot);
  if (description && !reference && !withModel) throw new Error('按描述找图需要先安装「图片搜索与识字」组件。');
  if (reference && !(await stat(reference).catch(() => undefined))?.isFile())
    throw new Error(`参考图片不存在：${reference}`);
  if (contains && !(withModel && ocrModelDirectory(imageModelDirectory(appRoot)!)))
    throw new Error('按图里的文字找图需要先安装「图片搜索与识字」组件。');
  return {
    reference,
    description,
    ...(contains ? { contains } : {}),
    ...(taken ? { taken } : {}),
    folders,
    limit,
    withModel,
  };
}

async function searchPass(
  appRoot: string,
  params: Params,
  budget: Budget,
  signal?: AbortSignal,
  progress?: Progress,
  scope: Scope = { folders: params.folders, version: 0 },
  memory?: Memory,
): Promise<Outcome> {
  const { reference, description, folders, withModel } = params;
  const store = theIndex();
  // Remember these folders so the idle pass keeps them ready for next time.
  store.folders = dedupeFolders([...store.folders, ...folders]).slice(-40);
  store.touch();

  let query: { size: number; sha: string; hash: string; vector?: Float32Array } | undefined;
  if (reference) {
    const info = await stat(reference).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`参考图片不存在：${reference}`);
    const rgb = await pixels(reference).catch(() => {
      throw new Error('无法读取参考图片（支持 JPG、PNG、WebP、GIF、TIFF、AVIF）。');
    });
    const [vector] = withModel ? await embedPictures(appRoot, [rgb]) : [];
    query = { size: info.size, sha: await sha256(reference), hash: differenceHash(rgb), vector };
  }
  const textVector = description ? await embedText(appRoot, description) : undefined;

  let pictures = await listPictures(folders);
  if (params.taken) pictures = await takenWithin(pictures, params.taken, budget.analyzeUntil, signal);
  // Only a time range: the pictures themselves are the answer, newest first; nothing needs analysing.
  if (!reference && !description && !params.contains) {
    const inside = pictures.filter((picture) => within(picture.path, scope.folders));
    const dated = inside
      .map((picture) => ({ path: picture.path, score: 1, at: dateOf(picture) }))
      .sort((a, b) => b.at - a.at);
    return {
      params: { ...params, folders: scope.folders },
      total: inside.length,
      analyzed: inside.length,
      remaining: 0,
      checked: 0,
      unchecked: 0,
      same: [],
      near: [],
      sources: [],
      similar: dated.map(({ path, score }) => ({ path, score })),
      texts: [],
      unread: 0,
    };
  }
  const remaining = await analyze(appRoot, pictures, {
    until: budget.analyzeUntil,
    batch: 8,
    signal,
    onProgress: (done, total) => progress?.('analyze', done, total),
    scope,
  });
  // Words in the picture: read the screenshot-like pictures of the scope (photos are skipped), then match.
  const unread = params.contains
    ? await readTexts(appRoot, pictures, {
        until: budget.readUntil ?? budget.analyzeUntil,
        phrase: params.contains,
        signal,
        scope,
        onProgress: (done, total) => progress?.('read', done, total),
      })
    : 0;

  const same: string[] = [];
  const near: Match[] = [];
  const similar: Match[] = [];
  const sources: Source[] = [];
  const referenceKey = reference.toLowerCase();
  const scored: Array<{ path: string; image?: number; text?: number }> = [];
  for (const picture of pictures) {
    const key = picture.path.toLowerCase();
    if (key === referenceKey || !within(picture.path, scope.folders)) continue;
    const entry = store.entries.get(key);
    if (!entry || entry.failed || !entry.hash) continue;
    if (query) {
      if (entry.size === query.size && (await sha256(entry.path).catch(() => '')) === query.sha) {
        same.push(entry.path);
        continue;
      }
      const distance = hammingDistance(entry.hash, query.hash);
      if (distance <= 10) {
        near.push({ path: entry.path, score: 1 - distance / 64 });
        continue;
      }
    }
    if (!entry.vector) continue;
    scored.push({
      path: entry.path,
      ...(query?.vector ? { image: cosine(entry.vector, query.vector, 127, 1) } : {}),
      ...(textVector ? { text: cosine(entry.vector, textVector, 127, 1) } : {}),
    });
  }
  // Picture-to-picture similarity runs about 0.6–1 (screenshots of any app already sit near 0.8), and
  // description-to-picture about 0.15–0.45. Only the closest band is kept, relative to the best match.
  const best = (key: 'image' | 'text') => Math.max(0, ...scored.map((row) => row[key] ?? 0));
  const imageFloor = Math.max(0.78, best('image') - 0.1),
    textFloor = Math.max(0.26, best('text') - 0.08);
  for (const row of scored) {
    const fromText = row.text !== undefined ? Math.max(0, Math.min(1, (row.text - 0.15) / 0.3)) : undefined;
    const fromImage = row.image !== undefined ? Math.max(0, Math.min(1, (row.image - 0.6) / 0.4)) : undefined;
    const score =
      fromText !== undefined && fromImage !== undefined
        ? fromImage * 0.6 + fromText * 0.4
        : (fromImage ?? fromText ?? 0);
    const kept = row.image !== undefined ? row.image >= imageFloor : row.text! >= textFloor;
    if (kept) similar.push({ path: row.path, score });
  }
  near.sort((a, b) => b.score - a.score);
  similar.sort((a, b) => b.score - a.score);

  // A partial screenshot: check candidates for the region, likeliest first (by content similarity), then
  // pictures not indexed yet. The matching itself runs in a worker thread.
  let checked = 0,
    unchecked = 0;
  if (reference) {
    const settled = new Set([...same, ...near.map((match) => match.path)].map((path) => path.toLowerCase()));
    const byImage = scored
      .filter((row) => row.image !== undefined)
      .sort((a, b) => b.image! - a.image!)
      .map((row) => row.path);
    const ranked = new Set(byImage.map((path) => path.toLowerCase()));
    const rest = pictures
      .map((picture) => picture.path)
      .filter((path) => !ranked.has(path.toLowerCase()) && path.toLowerCase() !== referenceKey);
    // Candidates this conversation already compared against the same picture are not compared again.
    const already = memory?.checked ?? new Set<string>();
    for (const source of memory?.sources ?? [])
      if (within(source.path, scope.folders) && !sources.some((item) => item.path === source.path))
        sources.push(source);
    const order = [...byImage, ...rest].filter(
      (path) => !settled.has(path.toLowerCase()) && !already.has(path.toLowerCase()),
    );
    checked = pictures.filter(
      (picture) => already.has(picture.path.toLowerCase()) && within(picture.path, scope.folders),
    ).length;
    const key = randomUUID();
    const count = await greyPixels(reference, 2000)
      .then((grey) => prepareQuery(key, grey))
      .catch(() => 0);
    if (count >= 30) {
      try {
        // A whole-picture match already answers the question; a sure source ends the search a little later.
        let until = Date.now() + (same.length || near.length ? Math.min(budget.matchFor, 15_000) : budget.matchFor);
        // The scope can shrink while this runs: candidates outside it are skipped, and the counts only ever
        // include what lies inside the current scope (earlier runs' checks, then this run's).
        const before = pictures.map((picture) => picture.path).filter((path) => already.has(path.toLowerCase()));
        const here: string[] = [];
        let version = -1,
          total = 0,
          earlier = 0;
        const inside = (paths: string[]) => paths.filter((path) => within(path, scope.folders)).length;
        const recount = () => {
          version = scope.version;
          earlier = inside(before);
          total = earlier + Math.min(inside(order), budget.matchLimit);
          checked = earlier + inside(here);
        };
        recount();
        const nextIn = (from: number) => {
          for (let j = from; j < order.length; j++) if (within(order[j]!, scope.folders)) return j;
          return -1;
        };
        // Candidates keep close to their own resolution, where a screenshot's region usually sits at a
        // similar scale; the next one decodes while the current one is matched.
        const decode = (index: number) =>
          index >= 0 ? greyPixels(order[index]!, 2000).catch(() => undefined) : undefined;
        let i = nextIn(0);
        let next = decode(i);
        while (i >= 0 && checked < total) {
          if (Date.now() > until || signal?.aborted) break;
          const grey = await next;
          const path = order[i]!;
          if (scope.version !== version) recount();
          const following = nextIn(i + 1);
          next = decode(following);
          i = following;
          if (!within(path, scope.folders)) continue;
          checked++;
          here.push(path);
          already.add(path.toLowerCase());
          progress?.('match', checked, total);
          if (!grey) continue;
          const points = await matchQuery(key, grey).catch(() => 0);
          if (points >= sourceThreshold) {
            sources.push({ path, points });
            memory?.sources.push({ path, points });
          }
          if (points >= sureSource) until = Math.min(until, Date.now() + 8_000);
        }
        await next;
        recount();
        unchecked = Math.max(0, inside(order) - inside(here));
      } finally {
        await releaseQuery(key);
      }
      sources.sort((a, b) => b.points - a.points);
      const found = new Set(sources.map((source) => source.path.toLowerCase()));
      for (let i = similar.length - 1; i >= 0; i--) if (found.has(similar[i]!.path.toLowerCase())) similar.splice(i, 1);
      // With the source found, look-alikes are only a footnote.
      if (sources.some((source) => source.points >= sureSource)) similar.splice(8);
    } else await releaseQuery(key);
  }
  // Report only what lies in the scope as it stands now (the user may have narrowed it meanwhile).
  const inside = pictures.filter((picture) => within(picture.path, scope.folders));
  const keep = <T>(items: T[], path: (item: T) => string) => items.filter((item) => within(path(item), scope.folders));
  const analyzed = inside.filter((picture) => store.entries.get(picture.path.toLowerCase())?.hash).length;
  return {
    params: { ...params, folders: scope.folders },
    total: inside.length,
    analyzed,
    remaining,
    checked,
    unchecked,
    same: keep(same, (path) => path),
    near: keep(near, (match) => match.path),
    sources: keep(sources, (source) => source.path),
    similar: keep(similar, (match) => match.path),
    texts: params.contains
      ? textMatches(
          inside.flatMap((picture) => store.entries.get(picture.path.toLowerCase()) ?? []),
          params.contains,
        )
      : [],
    unread,
  };
}

export async function executeImageSearch(...args: Parameters<typeof searchPass>): Promise<Outcome> {
  const end = beginPicturePass();
  try {
    return await searchPass(...args);
  } finally {
    await end();
  }
}

async function search(...args: Parameters<typeof searchPass>): Promise<Outcome> {
  if (!isMainThread) return executeImageSearch(...args);
  pauseImageBackground();
  const [appRoot, params, budget, signal, progress, scope, memory] = args;
  const reply = await runImageSearchWorker({ appRoot, params, budget, scope, memory }, signal, progress, scope);
  if (memory && reply.memory) {
    memory.checked = reply.memory.checked;
    memory.sources = reply.memory.sources;
  }
  return reply.outcome as Outcome;
}

/** When a listed picture was taken: its capture date, else its modified date. */
function dateOf(picture: Listed): number {
  const entry = theIndex().entries.get(picture.path.toLowerCase());
  return typeof entry?.taken === 'number' ? entry.taken : picture.mtime;
}

/**
 * The pictures taken in the range. Capture dates already in the index are used as they are; the others are
 * read now (only the header), until the deadline, after which the modified date stands in.
 */
async function takenWithin(pictures: Listed[], range: DateRange, until: number, signal?: AbortSignal) {
  const store = theIndex();
  const unread = pictures.filter((picture) => store.entries.get(picture.path.toLowerCase())?.taken === undefined);
  const read = new Map<string, number | null>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < unread.length && Date.now() < until && !signal?.aborted) {
        const picture = unread[cursor++]!;
        const taken = await captureTime(picture.path);
        read.set(picture.path.toLowerCase(), taken);
        const entry = store.entries.get(picture.path.toLowerCase());
        if (entry && entry.size === picture.size && entry.mtime === picture.mtime) {
          entry.taken = taken;
          store.touch();
        }
      }
    }),
  );
  await store.save();
  return pictures.filter((picture) => {
    const key = picture.path.toLowerCase();
    const known = store.entries.get(key)?.taken;
    const taken = typeof known === 'number' ? known : read.get(key);
    return inRange(typeof taken === 'number' ? taken : picture.mtime, range);
  });
}

/** The findings as lines; executors and the user read the same sections, with different notes around them. */
function findings(outcome: Outcome, user: boolean): string[] {
  const { same, near, sources, similar, params, texts } = outcome;
  const { limit, reference } = params;
  const heading = (text: string) => (user ? `**${text}**` : text);
  // In the conversation a path in code style can be clicked to open it in Explorer.
  const at = (path: string) => (user ? `\`${path}\`` : path);
  const lines: string[] = [];
  if (params.contains)
    lines.push(
      '',
      heading(`图里有“${params.contains}”字样的图片（${texts.length}）：`),
      ...(texts.length
        ? texts.slice(0, limit).map((match) => `- ${at(match.path)} —— “${match.line}”`)
        : ['（没有找到）']),
    );
  if (same.length)
    lines.push(
      '',
      heading(`完全相同的文件（${same.length}）：`),
      ...same.slice(0, limit).map((path) => `- ${at(path)}`),
    );
  if (near.length)
    lines.push(
      '',
      heading(`几乎一样的图片（缩放、压缩、重新截图或轻微裁剪；${near.length}）：`),
      ...near.slice(0, limit).map((match) => `- ${at(match.path)}（${percent(match.score)}）`),
    );
  if (sources.length)
    lines.push(
      '',
      heading(`包含这张截图内容的图片（截图可能只是它的一部分，或经过缩放；${sources.length}）：`),
      ...sources
        .slice(0, limit)
        .map(
          (source) =>
            `- ${at(source.path)}（${source.points} 个特征点吻合${source.points >= sureSource ? '，基本确定' : ''}）`,
        ),
    );
  const top = similar.slice(0, Math.max(limit, 40));
  if (top.length) {
    const groups = new Map<string, Match[]>();
    for (const match of top) {
      const folder = dirname(match.path);
      groups.set(folder, [...(groups.get(folder) ?? []), match]);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || b[1][0]!.score - a[1][0]!.score);
    // Only a time range asked: every picture in it counts, by folder, without a similarity.
    const listing = !reference && !params.description;
    const total = listing ? similar.length : top.length;
    if (listing) {
      groups.clear();
      for (const match of similar) {
        const folder = dirname(match.path);
        groups.set(folder, [...(groups.get(folder) ?? []), match]);
      }
    }
    const shown = listing ? [...groups.entries()].sort((a, b) => b[1].length - a[1].length) : ordered;
    lines.push(
      '',
      heading(
        listing
          ? `拍摄于 ${params.taken?.label ?? ''} 的图片，按文件夹（${total} 张，${shown.length} 个文件夹）：`
          : `${reference ? '内容相似' : '符合描述'}的图片，按文件夹（${top.length} 张，${ordered.length} 个文件夹）：`,
      ),
    );
    for (const [folder, matches] of shown.slice(0, 15)) {
      lines.push(
        listing
          ? `- ${at(folder)} —— ${matches.length} 张`
          : `- ${at(folder)} —— ${matches.length} 张，最高 ${percent(matches[0]!.score)}`,
      );
      for (const match of matches.slice(0, 4))
        lines.push(
          `  - ${user ? at(match.path) : basename(match.path)}${listing ? '' : `（${percent(match.score)}）`}`,
        );
    }
    if (shown.length > 15) lines.push(`- ……还有 ${shown.length - 15} 个文件夹`);
  }
  if (!params.contains && !same.length && !near.length && !sources.length && !top.length)
    lines.push('', '没有找到相似的图片。');
  return lines;
}

function counts(outcome: Outcome): string {
  return `范围内共 ${outcome.total} 张图片，已分析 ${outcome.analyzed} 张${outcome.params.reference ? `，逐张比对局部特征 ${outcome.checked} 张` : ''}${outcome.unread ? `，还有 ${outcome.unread} 张截图没读完文字` : ''}。`;
}

/** What the executor reads back from the tool. */
function forExecutor(outcome: Outcome, background: boolean, replaced = false): string {
  const { reference, description, folders, withModel } = outcome.params;
  const lines: string[] = [];
  if (replaced) lines.push('已停止这个对话之前的后台找图，改按下面的范围和条件进行。');
  if (reference) lines.push(`参考图片：${reference}`);
  if (description) lines.push(`描述：${description}`);
  if (outcome.params.contains) lines.push(`图里的文字：${outcome.params.contains}`);
  if (outcome.params.taken)
    lines.push(`拍摄时间：${outcome.params.taken.label}（按照片的拍摄日期；没有拍摄日期的按修改日期）`);
  lines.push(`搜索范围：${folders.join('；')}`, ...findings(outcome, false), '', counts(outcome));
  if (background)
    lines.push(
      '以上是初步结果。剩下的分析已转为后台任务：用户在对话框上方能看到进度，完成后完整结果会自动发到这个对话。' +
        '现在先把初步结果简要告诉用户，并说明后台在继续、完成后会自动发来；不要让用户过一会儿再来问。',
    );
  else {
    if (outcome.unchecked && !sureOf(outcome))
      lines.push(
        `若用户要找的是截图所在的原图而上面没有，还有 ${outcome.unchecked} 张没逐张比对：可以缩小 folders 范围再搜一次。`,
      );
    if (outcome.remaining) lines.push(`还有 ${outcome.remaining} 张图片没分析完，结果可能不完整；如实告诉用户。`);
  }
  if (!withModel) lines.push('只做了“相同/几乎一样”的比对；内容相似需要先安装「图片搜索与识字」组件。');
  return lines.join('\n');
}

/** The message a finished background search posts into the conversation. */
function forUser(outcome: Outcome): string {
  const { reference, description, folders } = outcome.params;
  const subject = reference
    ? `“${basename(reference)}”`
    : description
      ? `“${description}”`
      : outcome.params.contains
        ? `图里有“${outcome.params.contains}”字样`
        : `拍摄于 ${outcome.params.taken?.label ?? ''}`;
  const lines = [
    `后台找图已完成：${subject}`,
    '',
    `搜索范围：${folders.map((folder) => `\`${folder}\``).join('；')}`,
    ...findings(outcome, true),
    '',
    counts(outcome),
  ];
  if (reference && !sureOf(outcome) && outcome.unchecked)
    lines.push(
      `最相似的 ${outcome.checked} 张都逐张比对过，没有确定的原图；其余 ${outcome.unchecked} 张差别较大，可能不在这些文件夹里。`,
    );
  return lines.join('\n');
}

// ——— Background searches ———

export type ImageSearchTask = import('../shared/types.ts').BackgroundTask;
/**
 * One conversation's picture search: what it looks for and what it already did (kept for follow-ups such as
 * "only in this folder" or "keep looking"), and its background task while one exists. A task is running or
 * paused; pausing keeps everything, closing ends the task. Saved to disk, so a task cut off by a restart
 * shows as interrupted and continues from where it was.
 */
type Search = {
  conversationId: string;
  memory: Memory;
  task?: {
    id: string;
    state: 'running' | 'paused';
    interrupted?: boolean;
    detail: string;
    done: number;
    total: number;
    startedAt: string;
  };
  run?: { abort: AbortController; scope: Scope };
};
type SavedSearch = {
  conversationId: string;
  params: Params;
  checked: string[];
  sources: Source[];
  task?: Search['task'];
};
const searches = new Map<string, Search>();
let loaded = false;
let saveTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;
let taskRoot: string | undefined;

const searchesFile = () => join(imageIndexDirectory(), 'searches.json');
function loadSearches() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(readFileSync(searchesFile(), 'utf8')) as SavedSearch[];
    for (const item of saved) {
      const task = item.task
        ? {
            ...item.task,
            // A task that was running when the app stopped waits for the user to continue it.
            ...(item.task.state === 'running' ? { state: 'paused' as const, interrupted: true, detail: '已中断' } : {}),
          }
        : undefined;
      searches.set(item.conversationId, {
        conversationId: item.conversationId,
        memory: { params: item.params, checked: new Set(item.checked), sources: item.sources },
        ...(task ? { task } : {}),
      });
    }
  } catch {
    /* No saved searches yet. */
  }
}
function saveSearchesNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  const saved: SavedSearch[] = [...searches.values()].map(({ conversationId, memory, task }) => ({
    conversationId,
    params: memory.params,
    checked: [...memory.checked],
    sources: memory.sources,
    ...(task ? { task } : {}),
  }));
  try {
    const file = searchesFile();
    writeFileSync(`${file}.tmp`, JSON.stringify(saved));
    renameSync(`${file}.tmp`, file);
  } catch {
    /* The next change tries again. */
  }
}
function saveSearches() {
  saveTimer ??= setTimeout(saveSearchesNow, 3000);
  saveTimer.unref?.();
}
function searchFor(conversationId: string): Search | undefined {
  loadSearches();
  return searches.get(conversationId);
}

/** A picture the user attached is shown by the attachment URL the interface already loads. */
function previewUrl(conversationId: string, reference: string): string | undefined {
  const name = basename(reference);
  const id = name.match(/^([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\.[a-z0-9]{1,12}$/i)?.[1];
  return id && basename(dirname(reference)).toLowerCase() === 'attachments'
    ? `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${id}/content`
    : undefined;
}
let deliver: ((conversationId: string, text: string) => void) | undefined;
let changed: (() => void) | undefined;
let changeTimer: NodeJS.Timeout | undefined;

/** Where finished background searches post their results, and who hears about progress. */
export function connectImageSearch(options: {
  appRoot?: string;
  deliver: (conversationId: string, text: string) => void;
  changed: () => void;
}) {
  taskRoot = options.appRoot ?? taskRoot;
  deliver = options.deliver;
  changed = options.changed;
  loadSearches();
}

function notify(now = false) {
  if (now) {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = undefined;
    changed?.();
    saveSearchesNow();
    return;
  }
  saveSearches();
  changeTimer ??= setTimeout(() => {
    changeTimer = undefined;
    changed?.();
  }, 1000);
}

export function imageSearchTasks(): ImageSearchTask[] {
  loadSearches();
  return [...searches.values()].flatMap(({ conversationId, memory, task }) => {
    if (!task) return [];
    const { params } = memory;
    const preview = params.reference ? previewUrl(conversationId, params.reference) : undefined;
    return [
      {
        id: task.id,
        conversationId,
        title: params.reference ? '后台找图' : `后台找图：${params.description}`,
        detail: task.detail,
        done: task.done,
        total: task.total,
        startedAt: task.startedAt,
        state: task.state,
        folders: params.folders,
        ...(params.reference ? { reference: params.reference } : {}),
        ...(preview ? { previewUrl: preview } : {}),
      },
    ];
  });
}

const byTask = (id: string) => [...searches.values()].find((search) => search.task?.id === id);

/** Pauses a running search; what it did is kept and "continue" picks up from there. */
export function pauseImageSearchTask(id: string): boolean {
  const search = byTask(id);
  if (!search?.task || search.task.state !== 'running') return false;
  search.task = { ...search.task, state: 'paused', interrupted: false, detail: '已暂停' };
  search.run?.abort.abort();
  search.run = undefined;
  notify(true);
  return true;
}

/** Continues a paused or interrupted search where it stopped. */
export function resumeImageSearchTask(id: string): boolean {
  const search = byTask(id);
  if (!search?.task || search.task.state !== 'paused' || !taskRoot) return false;
  startTask(taskRoot, search.memory, search.conversationId, search.task.id);
  return true;
}

/** Ends a search for good (its findings so far stay available to follow-up messages). */
export function closeImageSearchTask(id: string): boolean {
  const search = byTask(id);
  if (!search?.task) return false;
  search.run?.abort.abort();
  search.run = undefined;
  search.task = undefined;
  notify(true);
  return true;
}

function startTask(appRoot: string, memory: Memory, conversationId: string, id: string = randomUUID()) {
  loadSearches();
  taskRoot ??= appRoot;
  const search: Search = searches.get(conversationId) ?? { conversationId, memory };
  search.memory = memory;
  searches.set(conversationId, search);
  // One search per conversation: a newer run replaces the older.
  search.run?.abort.abort();
  const abort = new AbortController();
  const scope: Scope = { folders: memory.params.folders, version: 0 };
  const run = { abort, scope };
  search.run = run;
  search.task = {
    id,
    state: 'running',
    detail: '准备中',
    done: search.task?.id === id ? search.task.done : 0,
    total: search.task?.id === id ? search.task.total : 0,
    startedAt: search.task?.id === id ? search.task.startedAt : new Date().toISOString(),
  };
  const task = search.task;
  notify(true);
  searching++;
  void search_(appRoot, memory, abort.signal, scope, (phase, done, total) => {
    if (search.task !== task) return;
    task.detail = phase === 'analyze' ? '正在分析图片' : phase === 'read' ? '正在读截图里的文字' : '正在逐张比对';
    task.done = done;
    task.total = total;
    notify();
  })
    .then((outcome) => {
      if (abort.signal.aborted || shuttingDown) return;
      deliver?.(conversationId, forUser(outcome));
      if (search.task === task) search.task = undefined;
    })
    .catch((error: unknown) => {
      if (abort.signal.aborted || shuttingDown) return;
      // Kept as paused, so the user can try again from where it stopped.
      if (search.task === task) search.task = { ...task, state: 'paused', detail: '出错，已暂停' };
      deliver?.(conversationId, `后台找图没有完成：${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      searching--;
      if (search.run === run) search.run = undefined;
      if (!shuttingDown) notify(true);
    });
}
const search_ = (appRoot: string, memory: Memory, signal: AbortSignal, scope: Scope, progress: Progress) =>
  search(
    appRoot,
    memory.params,
    {
      analyzeUntil: Number.POSITIVE_INFINITY,
      matchFor: 20 * 60_000,
      matchLimit: 1500,
      readUntil: Number.POSITIVE_INFINITY,
    },
    signal,
    progress,
    scope,
    memory,
  );

/** How long the executor waits for a first answer (milliseconds of indexing, then of keypoint checks). */
export const foregroundBudget = {
  withBackground: { analyze: 20_000, match: 25_000 },
  alone: { analyze: 40_000, match: 60_000 },
};

/**
 * The tool executors call. A reference picture, a description, or both; optional folders (absolute paths);
 * results grouped by folder. Within a conversation, a search that cannot finish in about 45 seconds hands the
 * rest to a background task that posts the full result into the conversation when it is done.
 */
/** A saved range back as from/to arguments, for a follow-up that keeps it. */
function takenArgs(range: DateRange) {
  const day = (seconds: number) => {
    const date = new Date(seconds * 1000);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  };
  return {
    ...(range.from !== undefined ? { from: day(range.from) } : {}),
    ...(range.to !== undefined ? { to: day(range.to) } : {}),
  };
}

export async function findSimilarImages(
  args: Record<string, unknown>,
  appRoot: string,
  signal?: AbortSignal,
  context: { conversationId?: string } = {},
): Promise<string> {
  taskRoot ??= appRoot;
  const existing = context.conversationId ? searchFor(context.conversationId) : undefined;
  const previous = existing?.memory;
  // A follow-up that only narrows the scope ("just in D:\\Downloads") or says "keep looking" keeps the
  // conversation's last picture.
  const reused = !args.image && !args.text && !args.contains && !args.from && !args.to && !!previous;
  const params = await readParams(
    reused
      ? {
          ...args,
          image: previous!.params.reference || undefined,
          text: previous!.params.description || undefined,
          contains: previous!.params.contains || undefined,
          ...(previous!.params.taken ? takenArgs(previous!.params.taken) : {}),
          ...(stringList(args.folders ?? args.folder).length ? {} : { folders: previous!.params.folders }),
        }
      : args,
    appRoot,
  );
  const named = stringList(args.folders ?? args.folder).length > 0;
  const sameSubject =
    !!previous &&
    previous.params.reference === params.reference &&
    previous.params.description === params.description &&
    previous.params.contains === params.contains &&
    JSON.stringify(previous.params.taken ?? null) === JSON.stringify(params.taken ?? null);
  const memory: Memory = sameSubject
    ? { params, checked: previous!.checked, sources: previous!.sources }
    : { params, checked: new Set(), sources: [] };
  const running = existing?.run;
  // The same picture with folders inside what is already being searched: keep going, only inside them.
  if (
    existing &&
    running &&
    sameSubject &&
    named &&
    params.folders.every((folder) => within(folder, running.scope.folders))
  ) {
    running.scope.folders = params.folders;
    running.scope.version++;
    existing.memory.params = params;
    notify(true);
    const found = existing.memory.sources.filter((source) => within(source.path, params.folders));
    return [
      `正在进行的后台找图已收窄到：${params.folders.join('；')}。`,
      '已经分析和比对过的图片都保留，剩下的只在这个范围里继续；进度在对话框上方，完成后完整结果会自动发到这个对话。',
      ...(found.length
        ? [
            '',
            '这个范围里目前已确认的：',
            ...found.map((source) => `- ${source.path}（${source.points} 个特征点吻合）`),
          ]
        : []),
      '',
      '简要告诉用户：已按新范围继续，不会重新开始。',
    ].join('\n');
  }
  // Otherwise this search replaces the conversation's earlier task (running or paused); what that one analyzed
  // and compared is kept and not redone.
  const replaced = !!existing?.task;
  const taskId = sameSubject ? existing?.task?.id : undefined;
  if (existing) {
    existing.run?.abort.abort();
    existing.run = undefined;
    existing.task = undefined;
  }
  if (context.conversationId) {
    searches.set(context.conversationId, { ...(existing ?? { conversationId: context.conversationId }), memory });
    notify(true);
  }
  const background = !!context.conversationId && !!deliver;
  const started = Date.now();
  const budget = background ? foregroundBudget.withBackground : foregroundBudget.alone;
  searching++;
  let outcome: Outcome;
  try {
    outcome = await search(
      appRoot,
      params,
      {
        analyzeUntil: started + budget.analyze,
        matchFor: budget.match,
        matchLimit: Number.POSITIVE_INFINITY,
        readUntil: started + budget.analyze + budget.match,
      },
      signal,
      undefined,
      undefined,
      memory,
    );
  } finally {
    searching--;
  }
  const incomplete =
    outcome.remaining > 0 ||
    outcome.unread > 0 ||
    (!!params.reference && outcome.unchecked > 0 && !sureOf(outcome) && outcome.checked < 1500);
  if (incomplete && background) {
    startTask(appRoot, memory, context.conversationId!, taskId);
    return forExecutor(outcome, true, replaced);
  }
  if (context.conversationId) notify(true);
  if (outcome.remaining) scheduleBackground(appRoot, 5_000);
  return forExecutor(outcome, false, replaced);
}

/**
 * For the next message in a conversation that searched pictures: what is being searched and how far it got,
 * so a follow-up such as "only in D:\\Downloads" or "keep looking" continues that search instead of starting
 * an unrelated one.
 */
export function imageSearchNote(conversationId: string): string {
  const existing = searchFor(conversationId);
  const last = existing?.memory.params;
  if (!last) return '';
  const task = existing.task;
  const subject = last.reference
    ? `参考图片 ${JSON.stringify(last.reference)}`
    : last.description
      ? `描述“${last.description}”`
      : `图里的文字“${last.contains}”`;
  const state = !task
    ? '之前找过图'
    : task.state === 'running'
      ? `正在后台找图（${task.detail}${task.total ? ` ${task.done}/${task.total}` : ''}）`
      : `有一个${task.interrupted ? '中断' : '暂停'}的后台找图（停在 ${task.done}/${task.total}）`;
  return (
    `\n\n这个对话${state}：${subject}，范围 ${last.folders.join('；')}。` +
    '如果用户这条消息是要继续找、或在调整找图的范围或条件（例如指定某个文件夹），直接调用 find_similar_images，' +
    '不用再传 image（会沿用这张参考图），调整范围时传新的 folders；已经分析和比对过的部分会保留，不会从头再来。' +
    '不要另起按文件名或其他方式的搜索。'
  );
}

// ——— Idle preparation ———

let timer: NodeJS.Timeout | undefined;
let backgroundRun: AbortController | undefined;
let backgroundGeneration = 0;
let checkingPower = false;
let deferredBackground: { appRoot: string; delay: number } | undefined;

/** Keeps the usual picture folders (and folders searched before) analyzed, slowly, while the app is idle. */
export function scheduleBackground(appRoot: string, delay = 90_000) {
  if (!isMainThread || timer || process.env.COMBORUNNER_IMAGE_BACKGROUND === '0' || !imageModelDirectory(appRoot))
    return;
  if (checkingPower || backgroundRun) {
    deferredBackground = { appRoot, delay };
    return;
  }
  timer = setTimeout(() => {
    timer = undefined;
    void backgroundPass(appRoot);
  }, delay);
  timer.unref();
}

function resumeDeferredBackground() {
  const deferred = deferredBackground;
  deferredBackground = undefined;
  if (deferred) scheduleBackground(deferred.appRoot, deferred.delay);
}

/** Whether the laptop runs on battery (checked at most every two minutes; a desktop never does). */
let power: { at: number; battery: boolean } | undefined;
export async function onBattery(): Promise<boolean> {
  if (power && Date.now() - power.at < 120_000) return power.battery;
  const battery = await systemOnBattery();
  power = { at: Date.now(), battery };
  return power.battery;
}

async function backgroundPass(appRoot: string) {
  const end = trackBusy('image-index');
  try {
    if (isMainThread) {
      if (backgroundRun) return;
      if (searching) return scheduleBackground(appRoot, 60_000);
      const generation = backgroundGeneration;
      checkingPower = true;
      let battery: boolean;
      try {
        battery = await onBattery();
      } finally {
        checkingPower = false;
        resumeDeferredBackground();
      }
      // Pausing invalidates this pass even if the component was reinstalled during the query.
      if (generation !== backgroundGeneration || !imageModelDirectory(appRoot)) return;
      if (battery) return scheduleBackground(appRoot, 5 * 60_000);
      const controller = (backgroundRun = new AbortController());
      try {
        const reply = await runImageSearchWorker({ appRoot }, controller.signal);
        if (!controller.signal.aborted && typeof reply.outcome === 'number') {
          backgroundRun = undefined;
          scheduleBackground(appRoot, reply.outcome);
        }
      } catch {
        if (!controller.signal.aborted && !shuttingDown) {
          backgroundRun = undefined;
          scheduleBackground(appRoot, 60_000);
        }
      } finally {
        backgroundRun = undefined;
        resumeDeferredBackground();
      }
      return;
    }
    return await backgroundPassImpl(appRoot);
  } finally {
    end();
  }
}

export const executeImageBackground = (appRoot: string, signal?: AbortSignal, progress?: Progress) =>
  backgroundPassImpl(appRoot, signal, progress);
async function backgroundPassImpl(appRoot: string, signal?: AbortSignal, progress?: Progress) {
  if (searching) return 60_000;
  if (signal?.aborted || !imageModelDirectory(appRoot)) return;
  const controller = (backgroundRun = new AbortController());
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const end = beginPicturePass();
  let remaining = 0;
  try {
    const store = theIndex();
    const pictures = await listPictures(dedupeFolders([...defaultImageFolders(), ...store.folders]));
    if (controller.signal.aborted || !imageModelDirectory(appRoot)) return;
    // On a graphics card the model is quick; the rest between batches keeps decoding light on the CPU.
    const gpu = (await modelProvider()) !== 'cpu';
    remaining = await analyze(appRoot, pictures, {
      until: Date.now() + 10 * 60_000,
      batch: gpu ? 8 : 4,
      pause: gpu ? 150 : 400,
      onProgress: (done, total) => progress?.('analyze', done, total),
      signal: controller.signal,
    });
    if (!remaining && gpu)
      remaining = await readTexts(appRoot, pictures, {
        until: Date.now() + 10 * 60_000,
        signal: controller.signal,
        onProgress: (done, total) => progress?.('read', done, total),
      });
    if (!remaining) {
      const undated = pictures.filter((picture) => {
        const entry = store.entries.get(picture.path.toLowerCase());
        return entry && !entry.failed && entry.taken === undefined;
      });
      for (const picture of undated) {
        if (controller.signal.aborted) break;
        const entry = store.entries.get(picture.path.toLowerCase());
        if (entry) entry.taken = await captureTime(picture.path);
        progress?.('analyze', 0, undated.length);
        store.touch();
        await store.save();
      }
      await store.save(true);
    }
  } catch {
    remaining = 0;
  } finally {
    signal?.removeEventListener('abort', abort);
    backgroundRun = undefined;
    await end();
  }
  return remaining ? 30_000 : 10 * 60_000;
}

export function pauseImageBackground() {
  backgroundGeneration++;
  deferredBackground = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
  backgroundRun?.abort();
}

export function stopImageBackground() {
  if (isMainThread) stopImageSearchWorker();
  pauseImageBackground();
  // Save running tasks as they are first: they show as interrupted next time and continue from there.
  shuttingDown = true;
  if (loaded) saveSearchesNow();
  for (const search of searches.values()) search.run?.abort.abort();
  stopMatchWorker();
}

export function imageSearchInUse() {
  return searching > 0 || [...searches.values()].some((search) => !!search.run);
}

export function imageIndexStatus(appRoot: string) {
  if (isMainThread)
    return {
      model: !!imageModelDirectory(appRoot),
      analyzed: imageWorkerStatus(appRoot),
      working: !!backgroundRun || [...searches.values()].some((search) => search.run),
      gpu: existsSync(gpuFile()),
    };
  const store = theIndex();
  let analyzed = 0;
  for (const entry of store.entries.values())
    if (entry.vector || (!imageModelDirectory(appRoot) && entry.hash)) analyzed++;
  return {
    model: !!imageModelDirectory(appRoot),
    analyzed,
    working: !!backgroundRun || [...searches.values()].some((search) => search.run),
    gpu: existsSync(gpuFile()),
  };
}
