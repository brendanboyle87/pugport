import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensurePtyHelperExecutable } from '../src/server/platform/pty-helper.ts';
import { fakeFs, fakeHost } from './helpers/fake-host.ts';

/* node-pty 1.1.0 ships spawn-helper as -rw-r--r--; the desktop terminal adds execute permission before a launch. */

function helperFs(modes: Record<string, number>, chmodError?: Error, links: string[] = []) {
  const changes: [string, number][] = [];
  const fs = fakeFs({
    lstatSync: (path: string) => {
      const mode = modes[path];
      if (mode === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return {
        isFile: () => !links.includes(path),
        mode: (links.includes(path) ? 0o120000 : 0o100000) | mode,
      } as Stats;
    },
    chmodSync: (path: string, mode: number) => {
      if (chmodError) throw chmodError;
      changes.push([path, mode]);
    },
  });
  return { fs, changes };
}

const root = '/Applications/PugPort.app/Contents/Resources/app/node_modules/node-pty';

test('a macOS helper published without execute permission becomes executable where it is readable', () => {
  const { fs, changes } = helperFs({ [`${root}/prebuilds/darwin-arm64/spawn-helper`]: 0o644 });
  assert.equal(ensurePtyHelperExecutable(root, 'arm64', fakeHost('darwin', { fs })), true);
  assert.deepEqual(changes, [[`${root}/prebuilds/darwin-arm64/spawn-helper`, 0o755]]);
});

test('only the helpers node-pty can load for this platform are changed, and executable ones are left alone', () => {
  const { fs, changes } = helperFs({
    [`${root}/build/Release/spawn-helper`]: 0o755,
    [`${root}/prebuilds/linux-x64/spawn-helper`]: 0o600,
    [`${root}/prebuilds/darwin-x64/spawn-helper`]: 0o644,
  });
  assert.equal(ensurePtyHelperExecutable(root, 'x64', fakeHost('linux', { fs })), true);
  assert.deepEqual(changes, [[`${root}/prebuilds/linux-x64/spawn-helper`, 0o700]]);
});

test('a helper inside an asar archive is fixed in its unpacked copy', () => {
  const packed = '/Applications/PugPort.app/Contents/Resources/app.asar/node_modules/node-pty';
  const unpacked = '/Applications/PugPort.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty';
  const { fs, changes } = helperFs({ [`${unpacked}/prebuilds/darwin-arm64/spawn-helper`]: 0o644 });
  ensurePtyHelperExecutable(packed, 'arm64', fakeHost('darwin', { fs }));
  assert.deepEqual(changes, [[`${unpacked}/prebuilds/darwin-arm64/spawn-helper`, 0o755]]);
});

test('a root already in the unpacked folder is used as it is', () => {
  const unpacked = '/Applications/PugPort.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty';
  const { fs, changes } = helperFs({ [`${unpacked}/prebuilds/darwin-arm64/spawn-helper`]: 0o644 });
  ensurePtyHelperExecutable(unpacked, 'arm64', fakeHost('darwin', { fs }));
  assert.deepEqual(changes, [[`${unpacked}/prebuilds/darwin-arm64/spawn-helper`, 0o755]]);
});

test('a helper that is a symbolic link is never changed', () => {
  const helper = `${root}/prebuilds/darwin-arm64/spawn-helper`;
  const { fs, changes } = helperFs({ [helper]: 0o644 }, undefined, [helper]);
  assert.equal(ensurePtyHelperExecutable(root, 'arm64', fakeHost('darwin', { fs })), true);
  assert.deepEqual(changes, []);
});

test('a read-only bundle reports that the helper stays unexecutable instead of throwing', () => {
  const { fs } = helperFs(
    { [`${root}/prebuilds/darwin-arm64/spawn-helper`]: 0o644 },
    Object.assign(new Error('EROFS'), { code: 'EROFS' }),
  );
  assert.equal(ensurePtyHelperExecutable(root, 'arm64', fakeHost('darwin', { fs })), false);
});

test('Windows has no spawn helper and touches no files', () => {
  assert.equal(ensurePtyHelperExecutable('C:\\PugPort\\node_modules\\node-pty', 'x64', fakeHost('win32')), true);
});

test(
  'a real helper file on this machine gains execute permission',
  { skip: process.platform === 'win32' && 'POSIX permissions' },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'pugport-pty-helper-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const helper = join(folder, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    await mkdir(join(helper, '..'), { recursive: true });
    await writeFile(helper, 'synthetic');
    await chmod(helper, 0o644);
    assert.equal(ensurePtyHelperExecutable(folder), true);
    assert.equal((await stat(helper)).mode & 0o777, 0o755);
  },
);
