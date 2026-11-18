import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReplyPath, resolveReplyPathCandidates } from '../src/server/app-settings.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-reply-paths-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  await mkdir(project);
  const file = async (path: string) => {
    const full = join(project, path);
    const { dirname } = await import('node:path');
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, 'fixture');
    return full;
  };
  return { directory, project, file };
}

test('full paths resolve without executing files, including executables outside the project', async (t) => {
  const { directory, project } = await fixture(t);
  const executable = join(directory, 'example.exe');
  await writeFile(executable, 'not an executable');
  assert.deepEqual(await resolveReplyPathCandidates(executable, [], project), { paths: [executable] });
  assert.deepEqual(await resolveReplyPathCandidates(project), { paths: [project] });
});

test('project-relative folders and files do not need a full path in the reply', async (t) => {
  const { project, file } = await fixture(t);
  const picture = await file('pictures/shot 1.png');
  assert.deepEqual(await resolveReplyPathCandidates('pictures', [], project), {
    paths: [join(project, 'pictures')],
  });
  assert.deepEqual(await resolveReplyPathCandidates('pictures\\shot 1.png', [], project), {
    paths: [picture],
  });
});

test('an explicit reply folder takes precedence over a duplicate elsewhere in the project', async (t) => {
  const { project, file } = await fixture(t);
  const chosen = await file('chosen/shot.png');
  await file('other/shot.png');
  assert.deepEqual(await resolveReplyPathCandidates('shot.png', [join(project, 'chosen')], project), {
    paths: [chosen],
  });
});

test('multiple explicit reply folders do not silently select the first filename', async (t) => {
  const { project, file } = await fixture(t);
  const first = await file('first/shot.png');
  const second = await file('second/shot.png');
  const bases = [join(project, 'first'), join(project, 'second')];
  assert.deepEqual((await resolveReplyPathCandidates('shot.png', bases, project)).paths.sort(), [first, second].sort());
  await assert.rejects(resolveReplyPath('shot.png', bases, project), /多个同名/);
});

test('bounded project search returns all exact duplicate names and excludes substring matches', async (t) => {
  const { project, file } = await fixture(t);
  const first = await file('first/movie 80.avi');
  const second = await file('second/movie 80.avi');
  await file('third/movie 800.avi');
  assert.deepEqual(
    (await resolveReplyPathCandidates('movie 80.avi', [], project)).paths.sort(),
    [first, second].sort(),
  );
});

test('omitted extensions match exact stems and offer different extensions as separate choices', async (t) => {
  const { project, file } = await fixture(t);
  const avi = await file('videos/movie 80.avi');
  const mp4 = await file('videos/movie 80.mp4');
  await file('videos/movie 800.mp4');
  assert.deepEqual((await resolveReplyPathCandidates('movie 80', [], project)).paths.sort(), [avi, mp4].sort());
});

test('relative reply resolution never climbs above the supplied project', async (t) => {
  const { directory, project, file } = await fixture(t);
  await writeFile(join(directory, 'outside.txt'), 'outside');
  const anchor = await file('nested/anchor.txt');
  assert.deepEqual(await resolveReplyPathCandidates('outside.txt', [anchor], project), { paths: [] });
  await assert.rejects(resolveReplyPath('../outside.txt', [anchor], project), /路径无效/);
});

test('fallback search skips dependency folders and directory junctions', async (t) => {
  const { directory, project, file } = await fixture(t);
  await file('node_modules/hidden.txt');
  await file('.git/hidden.txt');
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'hidden.txt'), 'outside');
  await symlink(outside, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await resolveReplyPathCandidates('hidden.txt', [], project), { paths: [] });
  assert.deepEqual(await resolveReplyPathCandidates('linked/hidden.txt', [], project), { paths: [] });
});

test('a depth-limited search is not reported as a unique result', async (t) => {
  const { project, file } = await fixture(t);
  await file('near/shot.png');
  await file('a/b/c/d/e/f/g/h/shot.png');
  const candidates = await resolveReplyPathCandidates('shot.png', [], project);
  assert.equal(candidates.paths.length, 1);
  assert.equal(candidates.truncated, true);
  await assert.rejects(resolveReplyPath('shot.png', [], project), /搜索范围较大/);
});

test('candidate lists are capped and mark omitted matches', async (t) => {
  const { project, file } = await fixture(t);
  await Promise.all(Array.from({ length: 25 }, (_, index) => file(`folder-${index}/shot.png`)));
  const candidates = await resolveReplyPathCandidates('shot.png', [], project);
  assert.equal(candidates.paths.length, 20);
  assert.equal(candidates.truncated, true);
});

test('missing paths and invalid context fail without opening a file manager', async (t) => {
  const { project } = await fixture(t);
  assert.deepEqual(await resolveReplyPathCandidates('missing.png', [], project), { paths: [] });
  await assert.rejects(resolveReplyPath('missing.png', [], project), /找不到/);
  await assert.rejects(resolveReplyPathCandidates('missing.png'), /路径无效/);
  await assert.rejects(resolveReplyPathCandidates('missing.png', ['relative-base']), /路径无效/);
  await assert.rejects(resolveReplyPathCandidates('D:relative.png', [], project), /路径无效/);
});
