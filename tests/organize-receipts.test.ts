import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import type { organizeFiles } from '../src/server/file-manager.ts';
import { userFolders } from '../src/server/platform/dirs.ts';
import { fakeHost } from './helpers/fake-host.ts';

// Synthetic filesystem; the real path/link protection code runs without touching protected host folders.
function fixture() {
  const root = path.resolve('synthetic-receipts');
  const source = path.join(root, 'input.txt');
  const target = path.join(root, 'out.txt');
  const files = new Map([[source, 'synthetic']]);
  const dirs = new Set([path.parse(root).root, root, ...(process.platform === 'win32' ? ['C:\\'] : [])]);
  const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
  const stat = async (value: string) => {
    if (!files.has(value) && !dirs.has(value)) throw missing();
    return { isFile: () => files.has(value), isDirectory: () => dirs.has(value), isSymbolicLink: () => false };
  };
  const fs = {
    stat,
    lstat: stat,
    realpath: async (value: string) => {
      await stat(value);
      return value;
    },
    mkdir: async (value: string) => {
      dirs.add(value);
    },
    link: async (from: string, to: string) => {
      assert.ok(files.has(from));
      assert.equal(files.has(to), false);
      files.set(to, files.get(from)!);
    },
    unlink: async (value: string) => {
      assert.ok(files.delete(value));
    },
    writeFile: async (value: string, content: string) => {
      files.set(value, content);
    },
    rename: async (from: string, to: string) => {
      assert.ok(files.has(from));
      files.set(to, files.get(from)!);
      files.delete(from);
    },
  };
  const host = fakeHost(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', {
    home: path.join(path.parse(root).root, 'fixture-home'),
    path,
    tmpdir: root,
  });
  const require = createRequire(import.meta.url);
  const mocks: Record<string, unknown> = {
    'node:fs/promises': fs,
    './local-tools.ts': {},
    './recycle-bin.ts': { maxRecyclePaths: 200 },
    './platform/dirs.ts': { appDirs: () => ({ fileMoves: path.join(root, 'journals') }) },
    './platform/host.ts': { currentHost: () => host },
    './host.ts': { currentHost: () => host },
    './dirs.ts': { userFolders },
  };
  const load = (filename: string): any => {
    const module = { exports: {} };
    const compiled = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    runInNewContext(compiled, {
      __filename: filename,
      module,
      exports: module.exports,
      require: (name: string) =>
        mocks[name] ?? (name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)),
      process: { platform: process.platform, env: {}, cwd: () => root },
      console,
      Buffer,
      setTimeout,
      clearTimeout,
    });
    return module.exports;
  };
  const api = load(fileURLToPath(new URL('../src/server/file-manager.ts', import.meta.url))) as {
    organizeFiles: typeof organizeFiles;
  };
  return { api, source, target, files, root };
}

test('organize with zero successful changes explicitly reports failure and exact counts', async () => {
  const f = fixture();
  const result = await f.api.organizeFiles(
    { moves: [{ from: path.join(f.root, 'missing.txt'), to: f.target }] },
    { recycle: false },
  );
  assert.deepEqual(
    [
      result.receipt.status,
      result.receipt.requested,
      result.receipt.succeeded,
      result.receipt.failed,
      result.receipt.skipped,
    ],
    ['failed', 1, 0, 1, 0],
  );
  assert.equal(result.receipt.operationIds.length, 1);
  assert.equal(result.journal, undefined);
  assert.ok(f.files.has(f.source));
});

test('organize partial success preserves the move, journal and operation id while counting skips', async () => {
  const f = fixture();
  const result = await f.api.organizeFiles(
    {
      moves: [
        { from: f.source, to: f.source },
        { from: f.source, to: f.target },
        { from: path.join(f.root, 'missing.txt'), to: path.join(f.root, 'other.txt') },
      ],
    },
    { recycle: false },
  );
  assert.deepEqual(
    [
      result.receipt.status,
      result.receipt.requested,
      result.receipt.succeeded,
      result.receipt.failed,
      result.receipt.skipped,
    ],
    ['partial', 3, 1, 1, 1],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result.receipt.moves)), [{ from: f.source, to: f.target }]);
  assert.equal(result.receipt.operationIds[0], result.journal?.id);
  assert.equal(f.files.has(f.source), false);
  assert.equal(f.files.get(f.target), 'synthetic');
  const saved = f.files.get(path.join(f.root, 'journals', `${result.journal!.id}.json`));
  assert.ok(saved);
  assert.deepEqual(JSON.parse(saved).moves, [{ from: f.source, to: f.target }]);
  assert.equal(
    [...f.files.keys()].some((filename) => filename.endsWith('.tmp')),
    false,
  );
});
