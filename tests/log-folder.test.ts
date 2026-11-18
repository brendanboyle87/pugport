import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogFolderHandler } from '../src/electron/log-folder.ts';

test('log folder handler ignores payload and opens only main-owned logs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-log-folder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened: string[] = [];
  const handler = createLogFolderHandler(
    directory,
    (event: { trusted: boolean }) => event.trusted,
    async (path) => {
      opened.push(path);
      return '';
    },
  );
  assert.equal(await handler({ trusted: false }, 'C:/Windows'), 'invalid');
  assert.deepEqual(opened, []);
  assert.equal(await handler({ trusted: true }, 'C:/Windows', { path: '/etc' }), '');
  assert.deepEqual(opened, [join(directory, 'logs')]);
  assert.ok((await stat(opened[0]!)).isDirectory());
});

test('log folder handler returns shell and filesystem failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-log-folder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(
    await createLogFolderHandler(
      directory,
      () => true,
      async () => 'cannot open',
    )(null),
    'cannot open',
  );
  assert.equal(
    await createLogFolderHandler(
      directory,
      () => true,
      async () => {
        throw Error('unavailable');
      },
    )(null),
    'failed',
  );
});
