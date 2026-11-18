import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fixtureFs from 'node:fs/promises';
import { electronModule } from './helpers/electron-harness.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { organizeFiles, undoOrganize, type MoveJournal } from '../src/server/file-manager.ts';

function fixture(t: TestContext) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-undo-retry-')));
  const before = process.env.COMBORUNNER_FILE_MOVES_DIR;
  process.env.COMBORUNNER_FILE_MOVES_DIR = join(dir, 'journals');
  t.after(() => {
    if (before === undefined) delete process.env.COMBORUNNER_FILE_MOVES_DIR;
    else process.env.COMBORUNNER_FILE_MOVES_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  });
  const context = { allowedRoots: [dir], recycle: false };
  return {
    dir,
    context,
    journal: (id: string) => JSON.parse(readFileSync(join(dir, 'journals', `${id}.json`), 'utf8')) as MoveJournal,
  };
}

test('partial undo keeps successful items and retries conflicts without overwriting files', async (t) => {
  const { dir, context, journal } = fixture(t);
  const moves = ['one', 'two'].map((name) => ({ from: join(dir, name), to: join(dir, `${name}-moved`) }));
  for (const item of moves) writeFileSync(item.from, item.from);
  const result = await organizeFiles({ moves }, context);
  const id = result.journal!.id;
  writeFileSync(moves[0]!.from, 'unrelated conflict');
  assert.match(await undoOrganize({ id }, context), /移回 1 项/);
  assert.equal(readFileSync(moves[0]!.from, 'utf8'), 'unrelated conflict');
  assert.equal(journal(id).undoneAt, undefined);
  unlinkSync(moves[0]!.from);
  assert.match(await undoOrganize({ id }, context), /移回 1 项/);
  for (const item of moves) assert.equal(readFileSync(item.from, 'utf8'), item.from);
  assert.ok(journal(id).undoneAt);
  assert.match(await undoOrganize({ id }, context), /已经.*撤销过/);
});

test('cancelled undo can resume and missing files never count as restored', async (t) => {
  const { dir, context, journal } = fixture(t);
  const from = join(dir, 'original'),
    to = join(dir, 'moved');
  writeFileSync(from, 'synthetic');
  const result = await organizeFiles({ moves: [{ from, to }] }, context);
  const id = result.journal!.id;
  await undoOrganize({ id }, { ...context, signal: AbortSignal.abort() });
  assert.equal(journal(id).undoneAt, undefined);
  unlinkSync(to);
  assert.match(await undoOrganize({ id }, context), /已经不在了/);
  assert.equal(journal(id).undoneAt, undefined);
  writeFileSync(to, 'synthetic');
  assert.match(await undoOrganize({ id }, context), /移回 1 项/);
  assert.equal(readFileSync(from, 'utf8'), 'synthetic');
});

async function withFaults(faults: Partial<typeof fixtureFs>) {
  return electronModule(
    'src/server/file-manager.ts',
    {},
    { fixtureFs: { ...fixtureFs, ...faults } },
    {
      'node:fs/promises': `export const { cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } = globalThis.fixtureFs;`,
    },
  );
}

for (const kind of ['file', 'folder'] as const) {
  test(`undo reconciles a ${kind} restored before its completion journal was written`, async (t) => {
    const { dir, context, journal } = fixture(t);
    const from = join(dir, 'original'),
      to = join(dir, 'moved');
    if (kind === 'folder') {
      mkdirSync(from);
      writeFileSync(join(from, 'contents'), 'synthetic');
    } else writeFileSync(from, 'synthetic');
    const result = await organizeFiles({ moves: [{ from, to }] }, context);
    const id = result.journal!.id;
    const api = await withFaults({
      rename: async (source, destination) => {
        if (String(destination).endsWith(`${id}.json`) && !existsSync(to) && existsSync(from))
          throw new Error('synthetic journal unavailable after move');
        return fixtureFs.rename(source, destination);
      },
    });
    await assert.rejects(api.undoOrganize({ id }, context), /synthetic journal/);
    assert.equal(journal(id).undoneAt, undefined);
    assert.equal(journal(id).moves[0]!.undo?.restoredAt, undefined);
    assert.equal(readFileSync(kind === 'folder' ? join(from, 'contents') : from, 'utf8'), 'synthetic');
    assert.match(await undoOrganize({ id }, context), /移回 1 项/);
    assert.ok(journal(id).undoneAt);
  });
}

test('undo resumes an interrupted same-volume hard link without duplicating or losing contents', async (t) => {
  const { dir, context, journal } = fixture(t);
  const from = join(dir, 'original'),
    to = join(dir, 'moved');
  writeFileSync(from, 'synthetic');
  const result = await organizeFiles({ moves: [{ from, to }] }, context);
  const id = result.journal!.id;
  const api = await withFaults({
    unlink: async (path) => {
      if (String(path) === to) throw new Error('synthetic interruption before source removal');
      return fixtureFs.unlink(path);
    },
  });
  assert.match(await api.undoOrganize({ id }, context), /移回 0 项/);
  assert.equal(journal(id).undoneAt, undefined);
  assert.equal(readFileSync(from, 'utf8'), 'synthetic');
  assert.equal(readFileSync(to, 'utf8'), 'synthetic');
  assert.match(await undoOrganize({ id }, context), /移回 1 项/);
  assert.equal(existsSync(to), false);
  assert.ok(journal(id).undoneAt);
});

test('a copied restore interrupted before removal keeps both copies until the user resolves it', async (t) => {
  const { dir, context, journal } = fixture(t);
  const from = join(dir, 'original'),
    to = join(dir, 'moved');
  writeFileSync(from, 'synthetic');
  const result = await organizeFiles({ moves: [{ from, to }] }, context);
  const id = result.journal!.id;
  const api = await withFaults({
    link: async () => {
      throw Object.assign(new Error('synthetic cross-volume move'), { code: 'EXDEV' });
    },
    unlink: async (path) => {
      if (String(path) === to) throw new Error('synthetic interruption before source removal');
      return fixtureFs.unlink(path);
    },
  });
  assert.match(await api.undoOrganize({ id }, context), /移回 0 项/);
  assert.match(await undoOrganize({ id }, context), /两份文件/);
  assert.equal(readFileSync(from, 'utf8'), 'synthetic');
  assert.equal(readFileSync(to, 'utf8'), 'synthetic');
  assert.equal(journal(id).undoneAt, undefined);
  unlinkSync(to);
  assert.match(await undoOrganize({ id }, context), /移回 1 项/);
  assert.ok(journal(id).undoneAt);
});

test('retry never treats an unrelated replacement as a restored item', async (t) => {
  const { dir, context, journal } = fixture(t);
  const from = join(dir, 'original'),
    to = join(dir, 'moved');
  writeFileSync(from, 'synthetic');
  const result = await organizeFiles({ moves: [{ from, to }] }, context);
  const id = result.journal!.id;
  const api = await withFaults({
    rename: async (source, destination) => {
      if (String(destination).endsWith(`${id}.json`) && !existsSync(to))
        throw new Error('synthetic journal unavailable after move');
      return fixtureFs.rename(source, destination);
    },
  });
  await assert.rejects(api.undoOrganize({ id }, context), /synthetic journal/);
  await fixtureFs.rename(from, join(dir, 'restored-kept'));
  writeFileSync(from, 'unrelated');
  assert.match(await undoOrganize({ id }, context), /同名文件/);
  assert.equal(readFileSync(from, 'utf8'), 'unrelated');
  assert.equal(journal(id).undoneAt, undefined);
});

test('cancellation after one move preserves that progress for retry', async (t) => {
  const { dir, context, journal } = fixture(t);
  const moves = ['one', 'two'].map((name) => ({ from: join(dir, name), to: join(dir, `${name}-moved`) }));
  for (const item of moves) writeFileSync(item.from, item.from);
  const result = await organizeFiles({ moves }, context);
  const id = result.journal!.id;
  const cancel = new AbortController();
  const api = await withFaults({
    unlink: async (path) => {
      await fixtureFs.unlink(path);
      if (String(path) === moves[1]!.to) cancel.abort();
    },
  });
  assert.match(await api.undoOrganize({ id }, { ...context, signal: cancel.signal }), /移回 1 项/);
  assert.equal(journal(id).undoneAt, undefined);
  assert.ok(journal(id).moves[1]!.undo?.restoredAt);
  assert.match(await undoOrganize({ id }, context), /移回 1 项/);
  assert.ok(journal(id).undoneAt);
});
