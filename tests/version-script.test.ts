import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('version bump rewrites only the version and keeps other identity exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-version-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src', 'shared'), { recursive: true });
    mkdirSync(join(root, 'docs'));
    writeFileSync(
      join(root, 'docs', 'DEPENDENCY-LICENSES.json'),
      JSON.stringify({ schemaVersion: 1, projectVersion: '0.0.34', packages: [] }, null, 2) + '\n',
    );
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'version.mjs'), join(root, 'scripts', 'version.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pugport', version: '0.0.34' }));
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ version: '0.0.34', packages: { '': { version: '0.0.34' } } }),
    );
    const identity = (version: string) =>
      `// Keep this release identity in sync with package.json via scripts/version.mjs.\n` +
      `export const APP_NAME = 'PugPort';\nexport const APP_VERSION = '${version}';\n` +
      `export const GITHUB_REPO_URL = 'https://example.invalid/repo';\n`;
    writeFileSync(join(root, 'src', 'shared', 'identity.ts'), identity('0.0.34'));
    execFileSync(process.execPath, [join(root, 'scripts', 'version.mjs'), 'patch'], { stdio: 'ignore' });
    assert.equal(readFileSync(join(root, 'src', 'shared', 'identity.ts'), 'utf8'), identity('0.0.35'));
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.0.35');
    assert.equal(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages[''].version, '0.0.35');
    assert.equal(
      JSON.parse(readFileSync(join(root, 'docs', 'DEPENDENCY-LICENSES.json'), 'utf8')).projectVersion,
      '0.0.35',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
