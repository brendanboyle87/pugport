// Build an inspectable source export only. Never commits, uploads, installs, or initializes Git.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blockedRootDirectories = new Set(['reports', 'vendor', 'dist', 'release']);
const blockedDirectories = new Set([
  '.git',
  '.data',
  '.comborunner',
  '.runtime',
  'node_modules',
  '.codex',
  '.claude',
  '.grok',
  '.pi',
  '.cache',
  '.state',
  '.idea',
  '.vscode',
  'coverage',
  '__pycache__',
]);

function relativePath(path) {
  if (typeof path !== 'string' || !path || /[\x00-\x1f\x7f:]/.test(path) || isAbsolute(path) || /^[\\/]/.test(path))
    throw new Error('Invalid source path');
  const normalized = path.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error(`Invalid source path: ${path}`);
  return normalized;
}

function exclusion(path) {
  const segments = path.toLowerCase().split('/'),
    name = segments.at(-1);
  if (blockedRootDirectories.has(segments[0])) return 'project runtime or external directory';
  if (segments.some((segment) => blockedDirectories.has(segment))) return 'private, generated, or external directory';
  if (segments.some((segment) => segment === '.env' || (segment.startsWith('.env.') && segment !== '.env.example')))
    return 'environment secrets';
  if (/^(auth|credentials|tokens)\.json$/.test(name)) return 'credential file';
  if (/\.(?:log|db|db-wal|db-shm|sqlite|sqlite3|pem|key|p12|pfx|exe|dll|node|zip|7z|tar|tgz|gz)$/i.test(name))
    return 'runtime, credential, archive, or local data file';
  return undefined;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkedFile(root, path, maxBytes) {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink excluded from source export: ${path}`);
  }
  const actual = realpathSync(current);
  if (!inside(root, actual)) throw new Error(`Source path escapes project: ${path}`);
  const stat = lstatSync(actual);
  if (!stat.isFile()) throw new Error(`Source candidate is not a regular file: ${path}`);
  if (stat.size > maxBytes) throw new Error(`Source file exceeds size limit: ${path}`);
  return { actual, size: stat.size };
}

function gitFiles(root) {
  // -z preserves exact names. Tracked files and untracked, non-ignored files are
  // both included; the independent deny list still rejects tracked local data.
  const list = (args) =>
    execFileSync('git', ['ls-files', ...args, '-z', '--', '.'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
      .split('\0')
      .filter(Boolean);
  // A source snapshot represents the working tree, including unstaged removals.
  // Only exclude deletions reported by Git; a selected file disappearing later
  // remains an error rather than silently producing an incomplete export.
  const deleted = new Set(list(['--deleted']));
  return list(['--cached', '--others', '--exclude-standard']).filter((path) => !deleted.has(path));
}

function ensureOutputParent(root) {
  let path = root;
  for (const segment of ['reports', 'publish']) {
    path = join(path, segment);
    if (!existsSync(path)) mkdirSync(path);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || !inside(root, realpathSync(path))) {
      throw new Error('Publication output must be a real directory inside the project');
    }
  }
  return path;
}

export function prepareSource(
  { root = defaultRoot, maxFileBytes = 20 * 1024 * 1024, maxTotalBytes = 150 * 1024 * 1024 } = {},
  { listFiles = gitFiles } = {},
) {
  root = realpathSync(root);
  const selected = [],
    excluded = [],
    seen = new Set();
  let totalBytes = 0;
  for (const raw of listFiles(root)) {
    const path = relativePath(raw),
      identity = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(identity)) continue;
    seen.add(identity);
    // Do not stat or read a rejected candidate, even if Git happens to track it.
    const reason = exclusion(path);
    if (reason) {
      excluded.push({ path, reason });
      continue;
    }
    const file = checkedFile(root, path, maxFileBytes);
    totalBytes += file.size;
    if (totalBytes > maxTotalBytes) throw new Error('Source export exceeds total size limit');
    selected.push({ path, ...file });
  }
  selected.sort((a, b) => a.path.localeCompare(b.path));
  for (const required of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json']) {
    if (!selected.some((file) => file.path === required))
      throw new Error(`Required publication file missing: ${required}`);
  }
  // License provenance may legitimately contain upstream src/vendor or dist
  // paths. Every collected supplement must survive the export filters intact.
  const selectedPaths = new Set(selected.map((file) => file.path));
  for (const path of ['docs/NPM-LICENSE-SUPPLEMENTS.json']) {
    if (!selectedPaths.has(path)) continue;
    const manifest = JSON.parse(readFileSync(checkedFile(root, path, maxFileBytes).actual, 'utf8'));
    for (const component of manifest.components ?? []) {
      for (const file of [
        ...(component.licenseFiles ?? []),
        ...(component.attributionFile ? [component.attributionFile] : []),
        ...(component.evidence ?? []),
      ]) {
        const referenced = relativePath(file.path.split('#')[0]);
        if (!selectedPaths.has(referenced))
          throw new Error(`Required license manifest material missing from source export: ${referenced}`);
      }
    }
  }
  const info = JSON.parse(readFileSync(checkedFile(root, 'package.json', maxFileBytes).actual, 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(info.version ?? ''))
    throw new Error('Invalid project version for source export');
  const parent = ensureOutputParent(root),
    name = `PugPort-${info.version}-source`;
  const outputDirectory = join(parent, name),
    manifestPath = join(parent, `${name}.manifest.json`);
  if (existsSync(outputDirectory) || existsSync(manifestPath))
    throw new Error('Source export already exists; preserve or move the previous export before running again');
  // Only create a new destination. Failed preparations are left for inspection,
  // with no success manifest; no existing directory is removed or overwritten.
  mkdirSync(outputDirectory);
  const files = [];
  for (const file of selected) {
    const current = checkedFile(root, file.path, maxFileBytes);
    if (current.size !== file.size || current.actual !== file.actual)
      throw new Error(`Source changed during preparation: ${file.path}`);
    const bytes = readFileSync(current.actual);
    if (bytes.length !== file.size) throw new Error(`Source changed during preparation: ${file.path}`);
    const destination = join(outputDirectory, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: 'wx' });
    files.push({ path: file.path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = {
    formatVersion: 1,
    product: 'PugPort',
    projectVersion: info.version,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
    excluded,
    note: 'Source snapshot only; no Git history, credentials, installed dependencies, or runtime binaries. No upload or commit performed.',
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return {
    outputDirectory,
    manifestPath,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    excludedCount: excluded.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(prepareSource(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
