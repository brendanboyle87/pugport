import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findFiles, readDocument, searchText, localToolStatus } from '../src/server/local-tools.ts';

const root = resolve(import.meta.dirname, '..');

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'local-tools-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'docs'));
  writeFileSync(join(directory, 'docs', '季度报告.md'), '# Q3\n营收增长 12%\n');
  writeFileSync(join(directory, 'docs', 'notes.txt'), 'nothing here\n');
  writeFileSync(join(directory, 'budget.csv'), 'item,amount\nservers,1200\n');
  return directory;
}

test('files are found by name inside a folder, case-insensitively', async (t) => {
  const directory = fixture(t);
  const result = await findFiles({ query: '报告', folder: directory }, directory);
  assert.match(result, /季度报告\.md/);
  assert.match(await findFiles({ query: 'BUDGET', folder: directory }, directory), /budget\.csv/);
  assert.match(await findFiles({ query: 'missing-name', folder: directory }, directory), /没有找到/);
  await assert.rejects(findFiles({ query: 'x', folder: 'relative/path' }, directory), /绝对路径/);
});

test('contents are searched with file and line', async (t) => {
  const directory = fixture(t);
  const result = await searchText({ pattern: '营收' }, directory);
  assert.match(result, /季度报告\.md:2:营收增长 12%/);
  assert.match(await searchText({ pattern: '营收', glob: '*.txt' }, directory), /没有找到/);
});

test('text files are read directly, and office files need MarkItDown', async (t) => {
  const directory = fixture(t);
  assert.match(await readDocument({ path: 'budget.csv' }, directory, root), /servers,1200/);
  await assert.rejects(readDocument({ path: 'nope.pdf' }, directory, root), /文件不存在/);
  writeFileSync(join(directory, 'empty.pdf'), '');
  // The fixture deliberately has no interpreter, regardless of this developer machine's setup.
  await assert.rejects(readDocument({ path: 'empty.pdf' }, directory, directory), /请先安装「读取本机办公文档」组件/);
});

test('paths from replies are only revealed when they are absolute and exist', async () => {
  const { revealPath } = await import('../src/server/app-settings.ts');
  await assert.rejects(revealPath('relative\\folder'), /路径无效/);
  await assert.rejects(revealPath('C:\\a"b'), /路径无效/);
  await assert.rejects(revealPath(join(tmpdir(), 'comborunner-missing-folder-for-test')), /找不到/);
});

test('a relative path from a reply is looked up only next to the full paths that reply names', async () => {
  const { revealPath } = await import('../src/server/app-settings.ts');
  await assert.rejects(revealPath('1.jpg'), /路径无效/);
  await assert.rejects(revealPath('..\\secret.txt', [tmpdir()]), /路径无效/);
  await assert.rejects(
    revealPath('missing-picture-for-test.jpg', [join(tmpdir(), 'x.jpg')]),
    /找不到：missing-picture/,
  );
  await assert.rejects(revealPath('1.jpg', ['relative\\base']), /路径无效/);
});

test('unscoped file search reports the project scope and never searches outside it', async (t) => {
  const directory = fixture(t);
  const result = await findFiles({ query: 'budget' }, directory);
  assert.ok(result.startsWith(directory));
  assert.match(result, /budget.csv/);
});

test('MarkItDown requires the ready marker for both status and reading documents', async (t) => {
  const directory = fixture(t);
  t.mock.property(process, 'env', { ...process.env, PUGPORT_RUNTIME_DIR: join(directory, '.runtime') });
  const runtime = join(directory, '.runtime', 'markitdown');
  const python = join(runtime, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  mkdirSync(join(runtime, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  writeFileSync(python, 'synthetic; must never execute');
  writeFileSync(join(directory, 'empty.pdf'), 'synthetic');
  assert.equal(localToolStatus(directory).markitdown, false);
  await assert.rejects(readDocument({ path: 'empty.pdf' }, directory, directory), /请先安装「读取本机办公文档」组件/);
  writeFileSync(join(runtime, '.pugport-ready'), 'ready');
  assert.equal(localToolStatus(directory).markitdown, true);
});
