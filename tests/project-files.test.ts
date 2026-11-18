import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { listProjectFiles, registerProjectFilesRoutes } from '../src/server/project-files-routes.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test('project listing bounds results, includes folders, fuzzy matches and ignores dependency/worktree trees', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pugport-file-picker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['src', 'node_modules', '.git', '.cache', '.claude/worktrees/nested']) {
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, 'hidden.ts'), 'fixture');
  }
  for (let i = 0; i < 65; i++) await writeFile(join(root, `file-${String(i).padStart(2, '0')}.txt`), 'fixture');
  await writeFile(join(root, 'src', 'Composer.tsx'), 'fixture');
  assert.equal((await listProjectFiles(root)).length, 50);
  const folders = await listProjectFiles(root, 'src');
  assert.ok(folders.some((item) => item.kind === 'folder' && item.path === 'src'));
  assert.deepEqual(await listProjectFiles(root, 'srccmp'), [{ path: 'src/Composer.tsx', kind: 'file' }]);
  assert.deepEqual(
    (await listProjectFiles(root, 'hidden')).map((item) => item.path),
    ['src/hidden.ts'],
  );
  assert.deepEqual(await listProjectFiles(root, '../../'), []);
});

test('project listing never follows a directory junction outside the project or a loop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pugport-file-boundary-'));
  const outside = await mkdtemp(join(tmpdir(), 'pugport-file-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, 'outside-secret.txt'), 'synthetic');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(root, join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await listProjectFiles(root), []);
});

test('HTTP route resolves only a registered project and treats q as a search, never a path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pugport-file-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'hello.ts'), 'fixture');
  const app = express();
  registerProjectFilesRoutes(app, (id) => (id === 'project' ? { path: root } : undefined));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/projects`;
  assert.deepEqual(await (await fetch(`${url}/project/files?q=hlo`)).json(), [{ path: 'hello.ts', kind: 'file' }]);
  assert.deepEqual(await (await fetch(`${url}/project/files?q=..%2F..%2F`)).json(), []);
  assert.equal((await fetch(`${url}/unknown/files`)).status, 404);
});

test('large trees remain bounded and cached listings serve new queries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pugport-file-large-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'pugport-file-large-')));
    await rm(root, { recursive: true, force: true });
  });
  // The large sibling is created first, but cannot consume the traversal budget before src.
  await mkdir(join(root, 'zzz-bulk'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'Workspace.tsx'), 'synthetic');
  for (let start = 0; start < 10100; start += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, 10100 - start) }, (_, offset) =>
        writeFile(join(root, 'zzz-bulk', start + offset + '.txt'), ''),
      ),
    );
  }
  t.mock.method(Date, 'now', () => 1_000_000);
  const files = await listProjectFiles(root, 'workspace.tsx');
  assert.deepEqual(files, [{ path: 'src/Workspace.tsx', kind: 'file' }]);
  await writeFile(join(root, 'src', 'new.ts'), 'synthetic');
  assert.deepEqual(await listProjectFiles(root, 'new.ts'), [], 'queries reuse the short-lived snapshot');
  assert.deepEqual(await listProjectFiles(root, 'wrkspc'), [{ path: 'src/Workspace.tsx', kind: 'file' }]);
});
