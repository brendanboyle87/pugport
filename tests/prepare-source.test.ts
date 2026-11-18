import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const { prepareSource } = await import(new URL('../scripts/prepare-source.mjs', import.meta.url).href);
const put = (path: string, value: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-source-prepare-')),
    root = join(directory, 'source');
  const paths = [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'package-lock.json',
    'src/main.ts',
    '.env.example',
    'docs/README.md',
  ];
  for (const path of paths)
    put(
      join(root, path),
      path.endsWith('.json') ? JSON.stringify({ name: 'fixture', version: '0.0.8' }) : `Synthetic source: ${path}\n`,
    );
  t.after(() => {
    const absolute = realpathSync(directory),
      rel = relative(realpathSync(tmpdir()), absolute);
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    assert.ok(basename(absolute).startsWith('comborunner-source-prepare-'));
    assert.equal(lstatSync(directory).isSymbolicLink(), false);
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    directory,
    root,
    paths,
    prepare: (extra: string[] = [], options = {}) =>
      prepareSource({ root, ...options }, { listFiles: () => [...paths, ...extra] }),
  };
}

test('source preparation deduplicates Git candidates, excludes local data without reading it, and records exact digests', (t) => {
  const f = fixture(t);
  const vendorLicense = 'licenses/npm/synthetic-addon/src/vendor/example/LICENSE';
  const manifestPath = 'docs/NPM-LICENSE-SUPPLEMENTS.json';
  put(join(f.root, vendorLicense), 'Required upstream vendor copyright and license.\n');
  put(join(f.root, manifestPath), JSON.stringify({ components: [{ licenseFiles: [{ path: vendorLicense }] }] }));
  f.paths.push(vendorLicense, manifestPath);
  // These denied paths deliberately do not exist: any attempted stat/read fails.
  const blocked = [
    '.git/config',
    '.data/auth.json',
    '.comborunner/conversations/private/history.jsonl',
    'nested/.comborunner/LATEST.md',
    '.runtime/node.exe',
    'node_modules/secret.txt',
    'reports/old.json',
    'vendor/source.ts',
    'dist/main.js',
    'release/app.exe',
    '.env',
    '.env.local',
    'nested/.env.production',
    'credentials.json',
  ];
  const result = f.prepare(['src/main.ts', ...blocked]);
  assert.equal(result.fileCount, f.paths.length);
  assert.equal(result.excludedCount, blocked.length);
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
  let bytes = 0;
  for (const file of manifest.files as { path: string; bytes: number; sha256: string }[]) {
    const actual = readFileSync(join(result.outputDirectory, file.path));
    assert.deepEqual(actual, readFileSync(join(f.root, file.path)));
    assert.equal(file.bytes, actual.length);
    assert.equal(file.sha256, createHash('sha256').update(actual).digest('hex'));
    bytes += actual.length;
  }
  assert.equal(manifest.totalBytes, bytes);
  assert.ok(existsSync(join(result.outputDirectory, '.env.example')));
  assert.ok(
    existsSync(join(result.outputDirectory, vendorLicense)),
    'upstream vendor license provenance is source material',
  );
  assert.ok(!existsSync(join(result.outputDirectory, '.git')));
  assert.throws(() => f.prepare(), /already exists/);
  assert.equal(readFileSync(join(result.outputDirectory, 'LICENSE'), 'utf8'), 'Synthetic source: LICENSE\n');
});

test('source preparation rejects traversal, outside junctions and oversized files before export', (t) => {
  const f = fixture(t);
  assert.throws(() => f.prepare(['../outside.txt']), /Invalid source path/);
  const outside = join(f.directory, 'outside');
  put(join(outside, 'private.txt'), 'Must not be exported.');
  symlinkSync(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.prepare(['linked/private.txt']), /Symlink excluded/);
  put(join(f.root, 'oversized.txt'), 'x'.repeat(1024));
  assert.throws(() => f.prepare(['oversized.txt'], { maxFileBytes: 100 }), /exceeds size limit/);
  assert.throws(() => f.prepare([], { maxTotalBytes: 1 }), /total size limit/);
  assert.ok(!existsSync(join(f.root, 'reports/publish')));
});

test('source preparation requires license, attribution and both package manifests', (t) => {
  const f = fixture(t);
  for (const required of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json']) {
    assert.throws(
      () => prepareSource({ root: f.root }, { listFiles: () => f.paths.filter((path) => path !== required) }),
      /Required publication file missing/,
    );
  }
  const path = 'docs/NPM-LICENSE-SUPPLEMENTS.json';
  put(join(f.root, path), JSON.stringify({ components: [{ licenseFiles: [{ path: 'licenses/missing/LICENSE' }] }] }));
  assert.throws(() => f.prepare([path]), /Required license manifest material missing/);
  assert.ok(!existsSync(join(f.root, 'reports/publish')));
});

test('source export includes working-tree additions and excludes tracked unstaged deletions', (t) => {
  const f = fixture(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '--', '.');
  rmSync(join(f.root, 'src/main.ts'));
  put(join(f.root, 'src/replacement.ts'), 'export const replacement = true;\n');
  const result = prepareSource({ root: f.root });
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
  assert.ok(!manifest.files.some((file: { path: string }) => file.path === 'src/main.ts'));
  assert.ok(manifest.files.some((file: { path: string }) => file.path === 'src/replacement.ts'));
  assert.ok(!existsSync(join(result.outputDirectory, 'src/main.ts')));
  assert.equal(
    readFileSync(join(result.outputDirectory, 'src/replacement.ts'), 'utf8'),
    'export const replacement = true;\n',
  );
});

test('source export still rejects a selected file disappearing after enumeration', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, 'src/main.ts'));
  assert.throws(() => f.prepare(), /ENOENT/);
  assert.ok(!existsSync(join(f.root, 'reports/publish')));
});
