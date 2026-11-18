import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { findFiles, readDocument, searchText } from '../src/server/local-tools.ts';
import { findDuplicates, organizeFiles, summarizeFolder, undoOrganize } from '../src/server/file-manager.ts';
import { startToolStep, traceToolStep, type ToolStep } from '../src/shared/tool-steps.ts';

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tool-steps-test-')));
  const folder = join(root, 'files'),
    app = join(root, 'app');
  mkdirSync(folder);
  mkdirSync(app);
  writeFileSync(join(folder, 'a.txt'), 'fixture needle '.repeat(200));
  writeFileSync(join(folder, 'b.txt'), 'fixture needle '.repeat(200));
  writeFileSync(join(folder, 'c.txt'), 'different');
  const previous = process.env.COMBORUNNER_FILE_MOVES_DIR;
  process.env.COMBORUNNER_FILE_MOVES_DIR = join(root, 'journals');
  t.after(() => {
    const target = resolve(root);
    assert.ok(
      target.startsWith(realpathSync.native(tmpdir()) + sep) && basename(target).startsWith('tool-steps-test-'),
    );
    rmSync(target, { recursive: true, force: true });
    if (previous === undefined) delete process.env.COMBORUNNER_FILE_MOVES_DIR;
    else process.env.COMBORUNNER_FILE_MOVES_DIR = previous;
  });
  const steps: ToolStep[] = [];
  return { root, folder, app, steps, options: { onStep: (step: ToolStep) => steps.push(step) } };
}
function pair(steps: ToolStep[], id: string, status: 'completed' | 'failed' = 'completed') {
  const found = steps.filter((step) => step.id === id);
  assert.deepEqual(
    found.map((step) => step.status),
    ['running', status],
    id,
  );
  return found[1];
}

test('observer and summary failures cannot change operation result/error and terminal notifications happen once', async () => {
  assert.equal(
    await traceToolStep(
      {
        onStep: () => {
          throw new Error('observer');
        },
      },
      'x',
      'x',
      () => 3,
    ),
    3,
  );
  assert.equal(
    await traceToolStep(
      {},
      'x',
      'x',
      () => 3,
      undefined,
      () => {
        throw new Error('summary');
      },
    ),
    3,
  );
  const original = new Error('original operation failure');
  await assert.rejects(
    traceToolStep(
      {
        onStep: () => {
          throw new Error('observer');
        },
      },
      'x',
      'x',
      () => {
        throw original;
      },
    ),
    (error) => error === original,
  );
  const steps: ToolStep[] = [];
  const handle = startToolStep({ onStep: (step) => steps.push(step) }, 'x', 'stage');
  handle.complete();
  handle.fail(new Error('late failure'));
  assert.deepEqual(
    steps.map((step) => step.status),
    ['running', 'completed'],
  );
  assert.ok(steps.every((step) => !('durationMs' in step) && !('startedAt' in step)));
});

test('file and content searches report actual ripgrep engine, bounded scope and observed counts', async (t) => {
  const { folder, app, steps, options } = fixture(t);
  assert.match(await findFiles({ query: 'a', folder }, folder, options), /a.txt/);
  const files = pair(steps, 'ripgrep-files');
  assert.equal(files.detail!.engine, 'ripgrep');
  assert.equal(files.detail!.scope, folder);
  assert.equal(files.detail!.count, 1);
  assert.ok(!steps.some((step) => step.id === 'everything'));
  steps.length = 0;
  assert.match(await searchText({ pattern: 'needle', folder }, folder, options), /a.txt/);
  assert.equal(pair(steps, 'ripgrep-text').detail!.count, 2);
  steps.length = 0;
  assert.match(await searchText({ pattern: 'not-present-fixture', folder }, folder, options), /没有找到/);
  assert.equal(pair(steps, 'ripgrep-text').detail!.count, 0);
  steps.length = 0;
  await searchText({ pattern: '[', folder }, folder, options);
  pair(steps, 'ripgrep-text', 'failed');
});

test('document read records filesystem extraction and validation failure without recording file contents', async (t) => {
  const { folder, app, steps, options } = fixture(t);
  assert.match(await readDocument({ path: 'a.txt' }, folder, app, options), /fixture needle/);
  const read = pair(steps, 'read-text');
  assert.equal(read.detail!.engine, 'filesystem');
  assert.equal(typeof read.detail!.characters, 'number');
  assert.ok(!JSON.stringify(steps).includes('fixture needle'));
  steps.length = 0;
  await assert.rejects(readDocument({ path: 'missing.txt' }, folder, app, options), /不存在/);
  pair(steps, 'validate', 'failed');
  assert.ok(!steps.some((step) => step.id === 'read-text'));
});

test('folder and duplicate processing report fallback, actual sample/full hashes and bounded summaries', async (t) => {
  const { folder, app, steps, options } = fixture(t);
  assert.match(await summarizeFolder({ folder }, options), /共 3 个文件/);
  assert.ok(!steps.some((step) => step.id === 'inventory-everything'));
  assert.equal(pair(steps, 'inventory-filesystem').detail!.count, 3);
  assert.equal(pair(steps, 'aggregate').detail!.files, 3);
  steps.length = 0;
  assert.match(await findDuplicates({ folders: [folder], min_size_kb: 1 }, undefined, options), /找到 1 组/);
  assert.equal(pair(steps, 'sample-hash').detail!.files, 2);
  assert.equal(pair(steps, 'full-hash').detail!.files, 2);
  assert.equal(pair(steps, 'duplicate-results').detail!.groups, 1);
  assert.ok(steps.length < 25);
});

test('organize and undo record batch moves and journal writes using only generated text fixtures', async (t) => {
  const { root, folder, app, steps, options } = fixture(t);
  const from = join(folder, 'c.txt'),
    to = join(folder, 'renamed.txt');
  const result = await organizeFiles(
    { moves: [{ from, to }] },
    { ...options, appRoot: app, recycle: false, conversationId: 'fixture' },
  );
  assert.equal(pair(steps, 'move-batch').detail!.moved, 1);
  assert.equal(pair(steps, 'write-journal').detail!.journal, result.journal!.id);
  assert.equal(readFileSync(to, 'utf8'), 'different');
  assert.ok(readFileSync(join(root, 'journals', `${result.journal!.id}.json`), 'utf8').includes('renamed.txt'));
  steps.length = 0;
  await undoOrganize({ id: result.journal!.id }, { ...options, appRoot: app, conversationId: 'fixture' });
  assert.equal(pair(steps, 'restore-batch').detail!.restored, 1);
  pair(steps, 'write-journal');
  assert.equal(readFileSync(from, 'utf8'), 'different');
});

test('denied and invalid recycle requests record failures and never perform a recycle operation', async (t) => {
  const { app, steps, options } = fixture(t);
  await assert.rejects(
    organizeFiles({ recycle: ['relative-only-fixture'] }, { ...options, appRoot: app, recycle: false }),
    /不能删除/,
  );
  pair(steps, 'validate', 'failed');
  assert.ok(!steps.some((step) => step.id === 'recycle-batch'));
  steps.length = 0;
  const result = await organizeFiles(
    { recycle: ['relative-only-fixture'] },
    { ...options, appRoot: app, recycle: true },
  );
  assert.equal(result.journal, undefined);
  const recycle = pair(steps, 'recycle-batch', 'failed');
  assert.equal(recycle.detail!.batches, 0);
  assert.equal(recycle.detail!.recycled, 0);
  assert.ok(!steps.some((step) => step.id === 'write-journal'));
});
