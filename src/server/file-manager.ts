import { findMoveJournal } from './file-manager-journals.ts';
import { resolveDataLocation } from '../shared/data-location.ts';
import { createHash, randomUUID } from 'node:crypto';
import { startToolStep, traceToolStep, type ToolStepOptions } from '../shared/tool-steps.ts';
import { constants, createReadStream } from 'node:fs';
import {
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { skippedFoldersBelow } from './local-tools.ts';
import { maxRecyclePaths, moveToRecycleBin } from './recycle-bin.ts';
import { appDirs } from './platform/dirs.ts';
import { currentHost, type Host } from './platform/host.ts';
import { protectedInside, protectedRoots, protectionKey } from './platform/protected-roots.ts';

/*
 * The file and photo keeper: what a folder holds and what takes the space, which files are exact copies of
 * each other, and tidying up (moving, renaming, recycling) with a record of every change, so "undo that"
 * puts everything back. Nothing is ever deleted permanently: removals go to the Recycle Bin.
 */

type Listed = { path: string; size: number; mtime: number; cloudOnly: boolean };

const kinds: Array<[string, RegExp]> = [
  ['图片', /\.(?:jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif|svg|raw|cr2|cr3|nef|arw|dng|orf|rw2)$/i],
  ['视频', /\.(?:mp4|mov|mkv|avi|wmv|flv|webm|m4v|ts|3gp|mts|m2ts)$/i],
  ['音频', /\.(?:mp3|wav|flac|aac|m4a|ogg|wma|amr|opus|ape)$/i],
  ['文档', /\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|rtf|odt|ods|odp|wps|et|dps|epub|mobi|azw3|pages|numbers|key)$/i],
  ['压缩包', /\.(?:zip|rar|7z|tar|gz|bz2|xz|tgz|iso|cab)$/i],
  ['安装程序', /\.(?:exe|msi|msix|appx|apk|dmg|pkg|deb|rpm)$/i],
  [
    '代码与数据',
    /\.(?:js|ts|tsx|jsx|py|java|c|cpp|h|cs|go|rs|html?|css|json|xml|ya?ml|sh|bat|ps1|ipynb|sql|db|sqlite)$/i,
  ],
];
const kindOf = (path: string) => kinds.find(([, pattern]) => pattern.test(path))?.[0] ?? '其他';
const kindFilters: Record<string, RegExp | undefined> = {
  all: undefined,
  images: kinds[0]![1],
  videos: kinds[1]![1],
  audio: kinds[2]![1],
  documents: kinds[3]![1],
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
const day = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

async function folderArg(value: unknown): Promise<string> {
  const path = typeof value === 'string' ? value.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!path || !isAbsolute(path)) throw new Error('folder 需要文件夹的完整路径。');
  if (!(await stat(path).catch(() => undefined))?.isDirectory()) throw new Error(`文件夹不存在：${path}`);
  return resolve(path);
}

/** Every file under a folder, by walking within limits. */
async function listFiles(
  folder: string,
  minBytes = 0,
  limit = 300_000,
  options: ToolStepOptions = {},
  stageId = 'inventory',
): Promise<{ files: Listed[]; partial: boolean }> {
  const files: Listed[] = [];
  const skipped = new Set(skippedFoldersBelow(folder).map((name) => name.toLowerCase()));
  const until = Date.now() + 60_000;
  let partial = false;
  let unreadable = 0;
  const walk = async (current: string) => {
    if (files.length >= limit || Date.now() > until) {
      partial = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      unreadable++;
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name.toLowerCase())) await walk(path);
      } else if (entry.isFile()) {
        const info = await stat(path).catch(() => undefined);
        if (info && info.size >= minBytes)
          files.push({ path, size: info.size, mtime: Math.floor(info.mtimeMs / 1000), cloudOnly: false });
      }
    }
  };
  await traceToolStep(
    options,
    `${stageId}-filesystem`,
    '遍历文件夹',
    () => walk(folder),
    { engine: 'filesystem', scope: folder, minBytes, limit },
    () => ({ count: files.length, partial, unreadable }),
  );
  return { files, partial };
}

/* ---------- What a folder holds ---------- */

export async function summarizeFolder(args: Record<string, unknown>, options: ToolStepOptions = {}): Promise<string> {
  return traceToolStep(options, 'summarize-folder', '统计文件夹内容', () => summarizeFolderImpl(args, options));
}
async function summarizeFolderImpl(args: Record<string, unknown>, options: ToolStepOptions): Promise<string> {
  const folder = await traceToolStep(options, 'validate', '检查统计文件夹范围', () => folderArg(args.folder));
  const top =
    typeof args.top === 'number' && Number.isFinite(args.top) ? Math.max(3, Math.min(Math.floor(args.top), 50)) : 10;
  const { files, partial } = await listFiles(folder, 0, 300_000, options);
  if (!files.length) return `${folder} 里没有文件。`;
  const aggregate = startToolStep(options, 'aggregate', '按类型和子目录汇总', { scope: folder, files: files.length });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const byKind = new Map<string, { count: number; size: number }>();
  const byChild = new Map<string, { count: number; size: number }>();
  const yearAgo = Date.now() / 1000 - 365 * 86_400;
  let old = 0,
    oldSize = 0,
    cloud = 0;
  for (const file of files) {
    if (file.cloudOnly) cloud++;
    const kind = byKind.get(kindOf(file.path)) ?? { count: 0, size: 0 };
    kind.count++;
    kind.size += file.size;
    byKind.set(kindOf(file.path), kind);
    const inside = relative(folder, file.path).split(sep);
    const child = inside.length > 1 ? inside[0]! : '（直接放在这一层的文件）';
    const entry = byChild.get(child) ?? { count: 0, size: 0 };
    entry.count++;
    entry.size += file.size;
    byChild.set(child, entry);
    if (file.mtime < yearAgo) {
      old++;
      oldSize += file.size;
    }
  }
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, top);
  const lines = [
    `文件夹：${folder}`,
    `共 ${files.length} 个文件，${formatBytes(total)}${cloud ? `（其中 ${cloud} 个只在云端，不占本机空间）` : ''}${partial ? '；文件太多，只统计了一部分' : ''}。`,
    '',
    '按类型：',
    ...[...byKind.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .map(([kind, value]) => `- ${kind}：${value.count} 个，${formatBytes(value.size)}`),
    '',
    `占空间最多的子文件夹：`,
    ...[...byChild.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, top)
      .map(
        ([child, value]) =>
          `- ${child.startsWith('（') ? child : join(folder, child)}：${value.count} 个文件，${formatBytes(value.size)}`,
      ),
    '',
    `最大的 ${largest.length} 个文件：`,
    ...largest.map((file) => `- ${file.path}（${formatBytes(file.size)}，${day(file.mtime)}）`),
    '',
    `一年以上没改动过的文件：${old} 个，${formatBytes(oldSize)}。`,
  ];
  aggregate.complete({ files: files.length, bytes: total, kinds: byKind.size, childFolders: byChild.size, partial });
  return lines.join('\n');
}

/* ---------- Exact copies ---------- */

async function hashOf(path: string, quick: boolean, size: number): Promise<string> {
  const hash = createHash('sha256');
  if (quick) {
    // The first and last 64 KB tell most different files of the same size apart without reading them whole.
    const handle = await open(path, 'r');
    try {
      const chunk = 64 * 1024;
      const head = Buffer.alloc(Math.min(chunk, size));
      await handle.read(head, 0, head.length, 0);
      hash.update(head);
      if (size > chunk) {
        const tail = Buffer.alloc(Math.min(chunk, size - chunk));
        await handle.read(tail, 0, tail.length, size - tail.length);
        hash.update(tail);
      }
    } finally {
      await handle.close();
    }
    return hash.digest('hex');
  }
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function findDuplicates(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  options: ToolStepOptions & { budgetMs?: number } = {},
): Promise<string> {
  return traceToolStep(options, 'find-duplicates', '查找内容完全相同的文件', () =>
    findDuplicatesImpl(args, signal, options),
  );
}
async function findDuplicatesImpl(
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: ToolStepOptions & { budgetMs?: number },
): Promise<string> {
  const validation = startToolStep(options, 'validate', '检查重复文件分析范围');
  const named = Array.isArray(args.folders) ? args.folders : typeof args.folder === 'string' ? [args.folder] : [];
  if (!named.length) {
    const error = new Error('请用 folders 给出要检查的文件夹（完整路径）。');
    validation.fail(error);
    throw error;
  }
  const folders: string[] = [];
  try {
    for (const value of named.slice(0, 20)) folders.push(await folderArg(value));
  } catch (error) {
    validation.fail(error);
    throw error;
  }
  validation.complete({ folders });
  const minBytes =
    typeof args.min_size_kb === 'number' && Number.isFinite(args.min_size_kb)
      ? Math.max(1, Math.floor(args.min_size_kb)) * 1024
      : 100 * 1024;
  const kind = typeof args.kind === 'string' && args.kind in kindFilters ? args.kind : 'all';
  const filter = kindFilters[kind];
  const seen = new Map<string, Listed>();
  let partial = false;
  for (const [index, folder] of folders.entries()) {
    const listed = await listFiles(folder, minBytes, 300_000, options, `inventory-${index}`);
    partial ||= listed.partial;
    for (const file of listed.files)
      if (!file.cloudOnly && (!filter || filter.test(file.path))) seen.set(file.path.toLowerCase(), file);
  }
  // Same size first; then the ends of the files; then the whole content, which alone proves a copy.
  const sizeFilter = startToolStep(options, 'size-filter', '按文件大小筛选候选', { files: seen.size, minBytes, kind });
  const bySize = new Map<number, Listed[]>();
  for (const file of seen.values()) bySize.set(file.size, [...(bySize.get(file.size) ?? []), file]);
  const candidates = [...bySize.values()].filter((group) => group.length > 1).sort((a, b) => b[0]!.size - a[0]!.size);
  sizeFilter.complete({ groups: candidates.length });
  const until = Date.now() + (options.budgetMs ?? 90_000);
  const groups: Listed[][] = [];
  let unchecked = 0;
  let quickStep: ReturnType<typeof startToolStep> | undefined, fullStep: ReturnType<typeof startToolStep> | undefined;
  let quickFiles = 0,
    fullFiles = 0,
    quickErrors = 0,
    fullErrors = 0;
  const split = async (group: Listed[], quick: boolean) => {
    if (quick)
      quickStep ??= startToolStep(options, 'sample-hash', '读取首尾样本计算 SHA-256', { engine: 'SHA-256 head/tail' });
    else fullStep ??= startToolStep(options, 'full-hash', '读取整文件计算 SHA-256', { engine: 'SHA-256 full-file' });
    const parts = new Map<string, Listed[]>();
    for (const file of group) {
      if (quick) quickFiles++;
      else fullFiles++;
      const key = await hashOf(file.path, quick, file.size).catch(() => {
        if (quick) quickErrors++;
        else fullErrors++;
        return '';
      });
      if (key) parts.set(key, [...(parts.get(key) ?? []), file]);
    }
    return [...parts.values()].filter((part) => part.length > 1);
  };
  for (const group of candidates) {
    if (Date.now() > until || signal?.aborted) {
      unchecked += group.length;
      continue;
    }
    for (const part of await split(group, true)) groups.push(...(await split(part, false)));
  }
  const finishHash = (step: ReturnType<typeof startToolStep> | undefined, files: number, errors: number) => {
    const detail = { files, errors, unchecked, partial };
    if (errors) step?.fail(new Error('部分文件读取失败。'), detail);
    else step?.complete(detail);
  };
  finishHash(quickStep, quickFiles, quickErrors);
  finishHash(fullStep, fullFiles, fullErrors);
  const resultStep = startToolStep(options, 'duplicate-results', '汇总已核验重复组', {
    groups: groups.length,
    unchecked,
    partial,
  });
  if (!groups.length) {
    resultStep.complete({ groups: 0, unchecked, partial });
    return `在 ${folders.join('；')} 里没有找到内容完全相同的文件（只比较 ${formatBytes(minBytes)} 以上的${kind === 'all' ? '' : '指定类型'}文件）。${unchecked ? `时间不够，还有 ${unchecked} 个同样大小的文件没比较完。` : ''}`;
  }
  // Keep the oldest (likely the original), and among equals the one with the shortest path.
  const ordered = groups
    .map((group) => [...group].sort((a, b) => a.mtime - b.mtime || a.path.length - b.path.length))
    .sort((a, b) => b[0]!.size * (b.length - 1) - a[0]!.size * (a.length - 1));
  const wasted = ordered.reduce((sum, group) => sum + group[0]!.size * (group.length - 1), 0);
  const shown = ordered.slice(0, 40);
  const lines = [
    `找到 ${ordered.length} 组内容完全相同的文件（逐字节比较确认），多出来的副本共占 ${formatBytes(wasted)}。`,
    '每组第一项建议保留（最早的那份），其余是副本：',
  ];
  shown.forEach((group, index) => {
    lines.push('', `${index + 1}. ${formatBytes(group[0]!.size)} × ${group.length}`);
    group.forEach((file, position) =>
      lines.push(`   ${position ? '- 副本' : '- 保留'}：${file.path}（${day(file.mtime)}）`),
    );
  });
  if (ordered.length > shown.length) lines.push('', `……还有 ${ordered.length - shown.length} 组没列出。`);
  if (unchecked) lines.push('', `时间不够，还有 ${unchecked} 个同样大小的文件没比较完；缩小范围再查可以查全。`);
  if (partial) lines.push('', '文件太多，只检查了一部分。');
  lines.push(
    '',
    '清理前先把结果告诉用户并确认要删哪些（用户已明确要求直接清理的除外）；删除用 organize_files 的 recycle（进回收站，可还原）。',
  );
  resultStep.complete({ groups: ordered.length, shown: shown.length, bytes: wasted, unchecked, partial });
  return lines.join('\n');
}

/* ---------- Tidying up, with undo ---------- */

type EntryIdentity = { dev: number; ino: number; birthtimeMs: number };

export type MoveJournal = {
  id: string;
  at: string;
  conversationId?: string;
  moves: {
    from: string;
    to: string;
    undo?: { source: EntryIdentity; destination?: EntryIdentity; restoredAt?: string };
  }[];
  recycled: string[];
  /** Folders this tidy-up created; undo removes them again when they are left empty. */
  created: string[];
  undoneAt?: string;
};

function entryIdentity(info: EntryIdentity): EntryIdentity {
  return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

function sameEntry(info: EntryIdentity, expected: EntryIdentity): boolean {
  return (
    expected.ino > 0 &&
    info.dev === expected.dev &&
    info.ino === expected.ino &&
    info.birthtimeMs === expected.birthtimeMs
  );
}

async function saveMoveJournal(journal: MoveJournal): Promise<void> {
  const folder = journalDirectory();
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `${journal.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(journal, null, 1), { flag: 'wx' });
    await rename(temporary, join(folder, `${journal.id}.json`));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function journalDirectory() {
  if (process.env.COMBORUNNER_FILE_MOVES_DIR) return resolve(process.env.COMBORUNNER_FILE_MOVES_DIR);
  return appDirs().fileMoves;
}

/** Where older releases kept tidy-up records (Linux: ~/.local/share/ComboRunner); read for undo, never written. */
function legacyJournalDirectories(): string[] {
  if (process.env.COMBORUNNER_FILE_MOVES_DIR) return [];
  return appDirs().legacy.fileMoves;
}

const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const inside = (path: string, folder: string) => {
  const rest = relative(fold(folder), fold(path));
  return !!rest && rest !== '..' && !/^\.\.[\\/]/.test(rest) && !isAbsolute(rest);
};

/** Resolve existing parents too: a new destination can be below a directory junction. */
async function canonicalDestination(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || dirname(current) === current)
        throw error;
      suffix.unshift(basename(current));
      current = dirname(current);
    }
  }
}

type GuardedPath = { path: string; entryPath: string; reason?: string };

type ProtectionOptions = { allowedRoots?: readonly string[]; dataDir?: string };

function privateRoots(appRoot: string | undefined, host: Host, options: ProtectionOptions): string[] {
  if (!options.allowedRoots?.length) return [];
  const dirs = appDirs(host);
  return [
    ...(appRoot ? [host.path.join(appRoot, '.data')] : []),
    options.dataDir ||
      (appRoot
        ? resolveDataLocation({ root: appRoot, env: host.env, fs: host.fs, path: host.path }).dataDir
        : host.env.COMBORUNNER_DATA_DIR || host.env.AGENT_STUDIO_DATA_DIR),
    dirs.secrets,
    dirs.memoryBase,
    dirs.vectors,
    dirs.imageIndex,
    dirs.everything,
    dirs.extensions,
    dirs.fileMoves,
    dirs.runtime,
    dirs.cache,
    host.path.join(host.home, '.codex'),
    host.env.CODEX_HOME,
    host.path.join(host.home, '.claude'),
    host.path.join(host.home, '.claude.json'),
    host.path.join(host.home, '.agents'),
    host.env.CLAUDE_CONFIG_DIR,
    host.env.GROK_HOME || host.path.join(host.home, '.grok'),
    host.path.join(host.env.GEMINI_CLI_HOME || host.home, '.gemini'),
    host.path.join(host.home, '.ssh'),
    ...['.aws', '.azure', '.kube', '.docker', '.gnupg', '.git-credentials'].map((name) =>
      host.path.join(host.home, name),
    ),
    host.path.join(host.home, '.config', 'gh'),
  ].filter((root): root is string => !!root);
}

/** Pin intermediate aliases while preserving a leaf link's own directory entry for move/undo. */
async function guardedCanonicalPath(
  path: string,
  role: 'from' | 'to',
  appRoot?: string,
  roots = new Map<string, Promise<string>>(),
  options: ProtectionOptions = {},
): Promise<GuardedPath> {
  const rootPath = (value: string) => {
    const key = resolve(value);
    if (!roots.has(key)) roots.set(key, canonicalDestination(key));
    return roots.get(key)!;
  };
  const lexical = protectedReason(path, role, appRoot, currentHost(), options);
  if (lexical) return { path: resolve(path), entryPath: resolve(path), reason: lexical };
  const absolute = resolve(path);
  const project = options.allowedRoots?.find(
    (root) => fold(absolute) === fold(resolve(root)) || inside(absolute, root),
  );
  if (project) {
    const entries: string[] = [];
    for (let entry = absolute; ; entry = dirname(entry)) {
      entries.unshift(entry);
      if (fold(entry) === fold(resolve(project)) || dirname(entry) === entry) break;
    }
    for (const entry of entries) {
      const info = await lstat(entry).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (info?.isSymbolicLink())
        return { path: absolute, entryPath: absolute, reason: '这是链接或目录联接，不能整理' };
    }
  }
  const entryPath = resolve(await canonicalDestination(dirname(absolute)), basename(absolute));
  const actual = await canonicalDestination(entryPath);
  const pinned = { path: actual, entryPath };
  const actualApp = appRoot ? await rootPath(appRoot) : undefined;
  const actualOptions = { ...options, allowedRoots: await Promise.all((options.allowedRoots ?? []).map(rootPath)) };
  const direct =
    protectedReason(entryPath, role, actualApp, currentHost(), actualOptions) ??
    protectedReason(actual, role, actualApp, currentHost(), actualOptions);
  if (direct) return { ...pinned, reason: direct };
  const host = currentHost();
  const boundary = protectedRoots(host);
  const key = (value: string) => protectionKey(value, host);
  const within = (child: string, folder: string) => protectedInside(child, folder, host);
  for (const root of privateRoots(appRoot, host, options)) {
    const canonical = await rootPath(root);
    if (key(actual) === key(canonical) || within(actual, canonical) || (role === 'from' && within(canonical, actual)))
      return { ...pinned, reason: '应用数据或账号文件夹，不能整理' };
  }
  // An exempt directory must not carry protected children or links along with it.
  if (project && role === 'from') {
    const checkTree = async (entry: string): Promise<string | undefined> => {
      const reason = protectedReason(entry, 'from', actualApp, host, actualOptions);
      if (reason) return reason;
      const info = await lstat(entry);
      if (info.isSymbolicLink()) return '这是链接或目录联接，不能整理';
      if (info.isDirectory())
        for (const name of await readdir(entry)) {
          const blocked = await checkTree(join(entry, name));
          if (blocked) return blocked;
        }
      return undefined;
    };
    const reason = await checkTree(entryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (reason) return { ...pinned, reason };
  }
  const allowed: string[] = [];
  for (const folder of boundary.allowedInside) allowed.push(await rootPath(folder));
  for (const candidate of new Set([entryPath, actual])) {
    if (!allowed.some((folder) => within(candidate, folder))) {
      for (const root of boundary.system) {
        const canonical = await rootPath(root);
        if (
          key(candidate) === key(canonical) ||
          within(candidate, canonical) ||
          (role === 'from' && within(canonical, candidate))
        )
          return { ...pinned, reason: '系统、程序或应用数据文件夹，不能整理' };
      }
    }
    if (role === 'from') {
      for (const root of [boundary.home, ...boundary.main])
        if (key(candidate) === key(await rootPath(root))) return { ...pinned, reason: '不能移动这个系统文件夹本身' };
    }
  }
  return pinned;
}

/** Keep the lexical guard and check physical protected roots, including an aliased app folder. */
export async function canonicalProtectedReason(
  path: string,
  role: 'from' | 'to',
  appRoot?: string,
  roots = new Map<string, Promise<string>>(),
  options: ProtectionOptions = {},
) {
  return (await guardedCanonicalPath(path, role, appRoot, roots, options)).reason;
}

// Cache only the protected roots for this operation. Each source/destination is resolved afresh.
function pathGuard(appRoot?: string, options: ProtectionOptions = {}) {
  const roots = new Map<string, Promise<string>>();
  return (path: string, role: 'from' | 'to') =>
    guardedCanonicalPath(path, role, appRoot, roots, options).catch((error: unknown): GuardedPath => ({
      path: resolve(path),
      entryPath: resolve(path),
      reason: `无法确认路径是否受保护：${error instanceof Error ? error.message : String(error)}`,
    }));
}

// Moves and their undo share one mutation queue: a free name is reserved until its move is committed.
// This also covers aliases and concurrent JSON-RPC batches, which a lexical destination lock would miss.
let mutations: Promise<void> = Promise.resolve();
async function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutations;
  let release!: () => void;
  mutations = new Promise<void>((resolveDone) => {
    release = resolveDone;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Why a path may not be tidied: system and program folders, app data, and the user's main folders themselves. */
export function protectedReason(
  path: string,
  role: 'from' | 'to',
  appRoot?: string,
  host: Host = currentHost(),
  options: ProtectionOptions = {},
): string | undefined {
  const boundary = protectedRoots(host);
  const key = (value: string) => protectionKey(host.path.resolve(value), host);
  const within = (child: string, folder: string) => protectedInside(child, folder, host);
  const unc = path.startsWith('\\\\');
  path = host.path.resolve(path);
  const exempt = options.allowedRoots?.some((root) => key(path) === key(root) || within(path, root));
  if (unc && !exempt) return '网络路径不在当前项目目录内，不能整理';
  if (exempt && /[\\/](?:\.git|\.data)(?:[\\/]|$)/i.test(path)) return '应用数据或 Git 目录，不能整理';
  if (
    privateRoots(appRoot, host, options).some(
      (root) => key(path) === key(root) || within(path, root) || (role === 'from' && within(root, path)),
    )
  )
    return '应用数据或账号文件夹，不能整理';
  if (
    !exempt &&
    appRoot &&
    (key(path) === key(appRoot) || within(path, appRoot) || (role === 'from' && within(appRoot, path)))
  )
    return '系统、程序或应用数据文件夹，不能整理';
  // The temporary folder holds the user's own things too (unpacked archives, downloads in progress).
  if (
    !boundary.allowedInside.some((folder) => within(path, folder)) &&
    boundary.system.some((folder) => key(path) === key(folder) || within(path, folder))
  )
    return '系统、程序或应用数据文件夹，不能整理';
  if (boundary.systemNames.test(path)) return '系统文件夹，不能整理';
  if (role === 'from') {
    if (host.path.parse(path).root === path || key(path) === key(boundary.home)) return '不能移动整个磁盘或用户文件夹';
    if (boundary.main.some((folder) => key(path) === key(folder))) return '不能移动这个系统文件夹本身';
  }
  return undefined;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A free name next to the wanted one: "photo (2).jpg", "photo (3).jpg", … */
async function freeName(path: string) {
  if (!(await exists(path))) return path;
  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);
  for (let number = 2; number < 10_000; number++) {
    const candidate = `${stem} (${number})${extension}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('同名文件太多。');
}

/** A move that also works across drives (copy, then remove the original). */
async function move(from: string, to: string, destinationReady?: () => Promise<void>) {
  if ((await lstat(from)).isFile()) {
    // Hard links reserve a same-volume filename atomically, without replacing an existing file.
    try {
      await link(from, to);
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await cp(from, to, { errorOnExist: true, force: false, preserveTimestamps: true, mode: constants.COPYFILE_EXCL });
    }
    await destinationReady?.();
    await unlink(from);
    return;
  }
  if (await exists(to)) throw new Error('目标已有同名文件或文件夹，没有覆盖');
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      mode: constants.COPYFILE_EXCL,
    });
    await destinationReady?.();
    await rm(from, { recursive: true, force: true });
  }
}

/** Creates the missing folders above a path, remembering which ones it made. */
async function ensureFolder(folder: string, created: string[]) {
  const missing: string[] = [];
  for (let current = folder; !(await exists(current)); current = dirname(current)) {
    missing.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const path of missing) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    created.push(path);
  }
}

export type OrganizeReceipt = {
  status: 'completed' | 'partial' | 'failed';
  operationIds: string[];
  requested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  moves: Array<{ from: string; to: string }>;
  recycled: string[];
  failures: string[];
  skippedPaths: string[];
};

export async function organizeFiles(
  args: Record<string, unknown>,
  context: { appRoot?: string; conversationId?: string; recycle: boolean; signal?: AbortSignal } & ProtectionOptions &
    ToolStepOptions,
): Promise<{ text: string; receipt: OrganizeReceipt; journal?: MoveJournal }> {
  return traceToolStep(
    context,
    'organize',
    '处理文件整理请求',
    () => mutate(() => organizeFilesLocked(args, context)),
    undefined,
    (result) => ({ ...result.receipt }),
  );
}

async function organizeFilesLocked(
  args: Record<string, unknown>,
  context: { appRoot?: string; conversationId?: string; recycle: boolean; signal?: AbortSignal } & ProtectionOptions &
    ToolStepOptions,
): Promise<{ text: string; receipt: OrganizeReceipt; journal?: MoveJournal }> {
  const guard = pathGuard(context.appRoot, context);
  const { moves, recycle } = await traceToolStep(
    context,
    'validate',
    '检查整理请求和权限',
    () => {
      const moves = Array.isArray(args.moves) ? args.moves : [];
      const recycle = Array.isArray(args.recycle)
        ? args.recycle.filter((item): item is string => typeof item === 'string')
        : [];
      if (!moves.length && !recycle.length)
        throw new Error('请用 moves 给出要移动或改名的文件，或用 recycle 给出要移到回收站的文件。');
      if (moves.length + recycle.length > 2000) throw new Error('一次最多整理 2000 项，请分批进行。');
      if (recycle.length && !context.recycle)
        throw new Error('这次运行不能删除文件，或已在设置中关闭“直接移到回收站”。');
      return { moves, recycle };
    },
    undefined,
    (result) => ({ moveRequests: result.moves.length, recycleRequests: result.recycle.length }),
  );
  const journal: MoveJournal = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    moves: [],
    recycled: [],
    created: [],
  };
  const failed: string[] = [];
  const skipped: string[] = [];
  const moveStep = moves.length
    ? startToolStep(context, 'move-batch', '检查路径并移动或重命名', { requests: moves.length })
    : undefined;
  try {
    for (const item of moves) {
      if (context.signal?.aborted) break;
      const row = (item ?? {}) as Record<string, unknown>;
      const from = typeof row.from === 'string' ? row.from.trim() : '';
      const target = typeof row.to === 'string' ? row.to.trim() : '';
      if (!from || !target || !isAbsolute(from) || !isAbsolute(target)) {
        failed.push(`${from || '（空）'}：from 和 to 都要写完整路径`);
        continue;
      }
      const sourcePath = await guard(from, 'from'),
        targetPath = await guard(target, 'to');
      const blocked = sourcePath.reason ?? targetPath.reason;
      if (blocked) {
        failed.push(`${from}：${blocked}`);
        continue;
      }
      if (!(await exists(sourcePath.entryPath))) {
        failed.push(`${from}：不存在`);
        continue;
      }
      // A folder (written with a trailing slash, or one that exists) receives the item under its own name.
      const intoFolder =
        /[\\/]$/.test(target) ||
        (await stat(targetPath.path).then(
          (info) => info.isDirectory(),
          () => false,
        ));
      let destination = resolve(
        intoFolder ? join(targetPath.path, basename(sourcePath.entryPath)) : targetPath.entryPath,
      );
      if (fold(destination) === fold(sourcePath.entryPath)) {
        skipped.push(sourcePath.entryPath);
        continue;
      }
      if (inside(destination, sourcePath.entryPath)) {
        failed.push(`${from}：不能移到它自己里面`);
        continue;
      }
      try {
        context.signal?.throwIfAborted();
        const source = await guard(sourcePath.entryPath, 'from'),
          target = await guard(destination, 'to');
        const blocked = source.reason ?? target.reason;
        if (blocked) throw new Error(blocked);
        destination = target.entryPath;
        await ensureFolder(dirname(destination), journal.created);
        destination = await freeName(destination);
        context.signal?.throwIfAborted();
        const finalSource = await guard(source.entryPath, 'from'),
          finalTarget = await guard(destination, 'to');
        const rechecked = finalSource.reason ?? finalTarget.reason;
        if (rechecked) throw new Error(rechecked);
        // This pins aliases, not OS directory identities: an external replacement of a physical parent
        // can still race filesystem operations. Never reopen the caller's lexical aliases after the guard.
        await move(finalSource.entryPath, finalTarget.entryPath);
        journal.moves.push({ from: finalSource.entryPath, to: finalTarget.entryPath });
      } catch (error) {
        failed.push(`${from}：${error instanceof Error ? error.message : '移动失败'}`);
      }
    }
  } catch (error) {
    moveStep?.fail(error, { moved: journal.moves.length, errors: failed.length });
    failed.push(error instanceof Error ? error.message : '整理已中断。');
  }
  if (failed.length || context.signal?.aborted)
    moveStep?.fail(new Error(context.signal?.aborted ? '整理已中断。' : '部分文件未移动。'), {
      moved: journal.moves.length,
      errors: failed.length,
    });
  else moveStep?.complete({ moved: journal.moves.length, errors: 0 });
  if (recycle.length) {
    const recycleStep = startToolStep(context, 'recycle-batch', '检查路径并分批移到回收站', {
      requests: recycle.length,
      maxBatch: maxRecyclePaths,
    });
    const errorsBefore = failed.length;
    let batches = 0;
    try {
      // The Recycle Bin helper works within one folder at a time; group the paths by their parent folder.
      const byParent = new Map<string, string[]>();
      for (const path of recycle) {
        if (!isAbsolute(path)) {
          failed.push(`${path}：需要完整路径`);
          continue;
        }
        if (context.signal?.aborted) break;
        const checked = await guard(path, 'from');
        if (checked.reason) failed.push(`${path}：${checked.reason}`);
        else if (
          await lstat(checked.entryPath).then(
            (entry) => entry.isSymbolicLink(),
            () => false,
          )
        )
          failed.push(`${path}：这是链接或目录联接，不能代为回收它指向的目标；请明确选择实际文件或文件夹。`);
        else byParent.set(dirname(checked.path), [...(byParent.get(dirname(checked.path)) ?? []), checked.path]);
      }
      for (const [parent, paths] of byParent) {
        if (context.signal?.aborted) break;
        const safePaths: string[] = [];
        for (const path of paths) {
          const checked = await guard(path, 'from');
          if (checked.reason) failed.push(`${path}：${checked.reason}`);
          else safePaths.push(checked.path);
        }
        if (!safePaths.length) continue;
        // organize_files accepts larger batches than the native Recycle Bin helper. Keep each
        // Windows operation within its limit instead of rejecting every item in a large folder.
        for (let offset = 0; offset < safePaths.length; offset += maxRecyclePaths) {
          if (context.signal?.aborted) break;
          const batch = safePaths.slice(offset, offset + maxRecyclePaths);
          batches++;
          const result = await moveToRecycleBin(parent, batch, context.signal).catch((error: unknown) => ({
            moved: [] as string[],
            failed: batch.map((path) => ({ path, reason: error instanceof Error ? error.message : '失败' })),
          }));
          journal.recycled.push(...result.moved);
          failed.push(...result.failed.map((item) => `${item.path}：${item.reason}`));
        }
      }
    } catch (error) {
      recycleStep.fail(error, { recycled: journal.recycled.length, batches });
      failed.push(error instanceof Error ? error.message : '回收已中断。');
    }
    const recycleErrors = failed.length - errorsBefore;
    if (recycleErrors || context.signal?.aborted)
      recycleStep.fail(new Error(context.signal?.aborted ? '回收已中断。' : '部分路径未回收。'), {
        recycled: journal.recycled.length,
        errors: recycleErrors,
        batches,
      });
    else recycleStep.complete({ recycled: journal.recycled.length, errors: 0, batches });
  }
  const changed = journal.moves.length + journal.recycled.length;
  let journalSaved = false;
  if (changed) {
    await traceToolStep(
      context,
      'write-journal',
      '保存可撤销的整理记录',
      async () => {
        await saveMoveJournal(journal);
        journalSaved = true;
      },
      { journal: journal.id, moved: journal.moves.length, recycled: journal.recycled.length },
    ).catch((error: unknown) => {
      failed.push(`整理记录保存失败：${error instanceof Error ? error.message : '未知错误'}`);
    });
  }
  const requested = moves.length + recycle.length;
  const failureCount = requested - changed - skipped.length;
  const lines = [
    `请求 ${requested} 项，成功 ${changed} 项，失败 ${failureCount} 项，跳过 ${skipped.length} 项。`,
    changed
      ? `已移动或改名 ${journal.moves.length} 项${journal.recycled.length ? `，移到回收站 ${journal.recycled.length} 项` : ''}。整理记录编号：${journal.id}。`
      : '没有改动任何文件。',
    ...journal.moves.slice(0, 30).map((move) => `- ${move.from} → ${move.to}`),
    ...(journal.moves.length > 30 ? [`- ……还有 ${journal.moves.length - 30} 项`] : []),
    ...journal.recycled.slice(0, 30).map((path) => `- 回收站：${path}`),
    ...(failed.length
      ? ['', `没有处理的 ${failed.length} 项：`, ...failed.slice(0, 30).map((line) => `- ${line}`)]
      : []),
    ...(journalSaved
      ? [
          '',
          '告诉用户整理结果，并说明随时可以说“撤销刚才的整理”恢复原样（用 undo_organize）；移到回收站的也可以在回收站里还原。',
        ]
      : []),
  ];
  const receipt: OrganizeReceipt = {
    status: failureCount || failed.length ? (changed ? 'partial' : 'failed') : 'completed',
    operationIds: [journal.id],
    requested,
    succeeded: changed,
    failed: failureCount,
    skipped: skipped.length,
    moves: journal.moves,
    recycled: journal.recycled,
    failures: failed,
    skippedPaths: skipped,
  };
  return { text: lines.join('\n'), receipt, ...(changed ? { journal } : {}) };
}

/** Puts back what a tidy-up moved (the latest one of this conversation unless an id is given). */
export async function undoOrganize(
  args: Record<string, unknown>,
  context: { conversationId?: string; appRoot?: string; signal?: AbortSignal } & ProtectionOptions & ToolStepOptions,
): Promise<string> {
  return traceToolStep(context, 'undo-organize', '处理整理撤销请求', () =>
    mutate(() => undoOrganizeLocked(args, context)),
  );
}

async function undoOrganizeLocked(
  args: Record<string, unknown>,
  context: { conversationId?: string; appRoot?: string; signal?: AbortSignal } & ProtectionOptions & ToolStepOptions,
): Promise<string> {
  const guard = pathGuard(context.appRoot, context);
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const journal = await traceToolStep(
    context,
    'select-journal',
    '选择要撤销的整理记录',
    async () => {
      const selected = await findMoveJournal(
        [journalDirectory(), ...legacyJournalDirectories()],
        id,
        context.conversationId,
      );
      if (!selected) throw new Error(id ? `没有编号为 ${id} 的整理记录。` : '这个对话里没有可以撤销的整理。');
      return selected;
    },
    { requestedJournal: id || 'latest' },
    (result) => ({ journal: result.id, alreadyUndone: !!result.undoneAt }),
  );
  if (journal.undoneAt) return `整理 ${journal.id} 已经在 ${journal.undoneAt} 撤销过了。`;
  let restored = 0;
  const failed: string[] = [];
  const restoreStep = startToolStep(context, 'restore-batch', '检查路径并移回原位置', {
    requests: journal.moves.length,
    journal: journal.id,
  });
  try {
    for (const item of [...journal.moves].reverse()) {
      if (context.signal?.aborted) break;
      if (item.undo?.restoredAt) continue;
      try {
        const source = await guard(item.to, 'from'),
          target = await guard(item.from, 'to');
        const blocked = source.reason ?? target.reason;
        if (blocked) throw new Error(blocked);
        const inspect = (path: string) =>
          lstat(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
        const sourceInfo = await inspect(source.entryPath);
        const targetInfo = await inspect(target.entryPath);
        if (targetInfo) {
          const expected = item.undo?.destination ?? item.undo?.source;
          if (!expected || !sameEntry(targetInfo, expected)) throw new Error('原位置已有同名文件，没有覆盖');
          if (sourceInfo) {
            // Only a shared inode proves that removing an interrupted hard link loses no content.
            if (!sourceInfo.isFile() || !sameEntry(sourceInfo, targetInfo))
              throw new Error('上次移回留下了两份文件，请确认保留原位置文件并移走整理位置的副本后重试');
            context.signal?.throwIfAborted();
            await unlink(source.entryPath);
          }
        } else {
          if (!sourceInfo) throw new Error('已经不在了');
          if (item.undo && !sameEntry(sourceInfo, item.undo.source))
            throw new Error('整理位置的文件已经改变，没有移动');
          await mkdir(dirname(target.entryPath), { recursive: true });
          context.signal?.throwIfAborted();
          const finalSource = await guard(source.entryPath, 'from'),
            finalTarget = await guard(target.entryPath, 'to');
          const rechecked = finalSource.reason ?? finalTarget.reason;
          if (rechecked) throw new Error(rechecked);
          item.undo = { source: entryIdentity(await lstat(finalSource.entryPath)) };
          await saveMoveJournal(journal);
          context.signal?.throwIfAborted();
          await move(finalSource.entryPath, finalTarget.entryPath, async () => {
            item.undo!.destination = entryIdentity(await lstat(finalTarget.entryPath));
            await saveMoveJournal(journal);
          });
        }
        item.undo!.restoredAt = new Date().toISOString();
        await saveMoveJournal(journal);
        restored++;
      } catch (error) {
        failed.push(`${item.to}：${error instanceof Error ? error.message : '移回失败'}`);
      }
    }
  } catch (error) {
    restoreStep.fail(error, { restored, errors: failed.length });
    throw error;
  }
  if (failed.length || context.signal?.aborted)
    restoreStep.fail(new Error(context.signal?.aborted ? '撤销已中断。' : '部分文件未移回。'), {
      restored,
      errors: failed.length,
    });
  else restoreStep.complete({ restored, errors: 0 });
  // Folders the tidy-up made are removed again if nothing is left in them (deepest first).
  await traceToolStep(
    context,
    'cleanup-folders',
    '尝试移除整理创建的空文件夹',
    async () => {
      for (const folder of [...journal.created].sort((a, b) => b.length - a.length)) {
        if (context.signal?.aborted) break;
        const checked = await guard(folder, 'from');
        if (!checked.reason) await rmdir(checked.entryPath).catch(() => undefined);
      }
    },
    { candidates: journal.created.length },
  );
  const remaining = journal.moves.filter((item) => !item.undo?.restoredAt).length;
  if (!remaining && !context.signal?.aborted) journal.undoneAt = new Date().toISOString();
  await traceToolStep(context, 'write-journal', '保存撤销状态', () => saveMoveJournal(journal), {
    journal: journal.id,
    restored,
    remaining,
  });
  return [
    `已${journal.undoneAt ? '' : '部分'}撤销整理 ${journal.id}：移回 ${restored} 项。`,
    ...(!journal.undoneAt ? [`还有 ${remaining} 项未完成，可处理冲突后重试撤销。`] : []),
    ...(journal.recycled.length
      ? [
          `移到回收站的 ${journal.recycled.length} 项需要在回收站里还原：`,
          ...journal.recycled.slice(0, 20).map((path) => `- ${path}`),
        ]
      : []),
    ...(failed.length
      ? ['', `没有移回的 ${failed.length} 项：`, ...failed.slice(0, 30).map((line) => `- ${line}`)]
      : []),
  ].join('\n');
}
