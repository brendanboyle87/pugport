import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { deleteAccountHome } from '../src/server/account-home.ts';
import { appendLaneEvent, laneEventsPath } from '../src/server/lane-events.ts';
import { installLocalMemoryBootstrap } from '../src/server/local-memory-bootstrap.ts';
import { LocalMediaStagingCache } from '../src/server/media-staging.ts';
import { ProjectPurger } from '../src/server/project-purge.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Project } from '../src/shared/types.ts';

/*
 * A folder the app is given may sit below a link it does not own: macOS reaches its temporary folder through
 * /var -> /private/var, and a checkout or project can be reached through a user's link. Each check tolerates
 * links above the given folder and still refuses a link at that folder or inside it. Windows keeps refusing
 * junctions anywhere on the path (trustedDirectory leaves its paths unchanged), so these cases are POSIX-only.
 */
const posix = { skip: process.platform === 'win32' && 'Windows keeps refusing junctions above the given folder' };

/** `real` is an ordinary folder; `linked` reaches the same folder through a link in its parent. */
function linkedParent(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pugport-linked-parent-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  mkdirSync(real);
  symlinkSync(real, join(base, 'link'), 'dir');
  return { base, real, linked: join(base, 'link') };
}

test('a managed account folder below a linked data folder parent is deleted', posix, async (t) => {
  const { real, linked } = linkedParent(t);
  // Accounts are created below the real data folder (native-accounts resolves it); deletion is given the data
  // folder as configured.
  const home = join(real, 'data', 'accounts', randomUUID());
  mkdirSync(join(home, 'profile'), { recursive: true });
  writeFileSync(join(home, 'profile', 'auth.json'), '{}');
  assert.equal(await deleteAccountHome(join(linked, 'data', 'accounts'), home), true);
  assert.equal(existsSync(home), false);
});

test('a linked accounts folder still keeps its account folders', posix, async (t) => {
  const { base, real } = linkedParent(t);
  const home = join(real, 'accounts', randomUUID());
  mkdirSync(home, { recursive: true });
  symlinkSync(join(real, 'accounts'), join(base, 'accounts'), 'dir');
  assert.equal(await deleteAccountHome(join(base, 'accounts'), home), false);
  assert.equal(existsSync(home), true);
});

test(
  'project memory rules install in a project reached through a linked parent, never through a linked project',
  posix,
  (t) => {
    const { base, real, linked } = linkedParent(t);
    mkdirSync(join(real, 'project'));
    const installed = installLocalMemoryBootstrap(join(linked, 'project'));
    assert.deepEqual(installed.warnings, []);
    assert.ok(installed.files.length > 0);
    assert.match(readFileSync(join(real, 'project', 'AGENTS.md'), 'utf8'), /LOCAL MEMORY/);
    symlinkSync(join(real, 'project'), join(base, 'project-link'), 'dir');
    const refused = installLocalMemoryBootstrap(join(base, 'project-link'));
    assert.deepEqual(refused.files, []);
    assert.equal(refused.warnings.length, 1);
  },
);

test('a media cache below a linked parent is accepted, a linked cache folder is not', posix, async (t) => {
  const { base, real, linked } = linkedParent(t);
  mkdirSync(join(real, 'cache'));
  await LocalMediaStagingCache.cleanupStale(join(linked, 'cache'));
  symlinkSync(join(real, 'cache'), join(base, 'cache-link'), 'dir');
  await assert.rejects(LocalMediaStagingCache.cleanupStale(join(base, 'cache-link')), /aliases/);
});

test('a project purge removes app data below a linked data folder parent', posix, async (t) => {
  const { linked } = linkedParent(t);
  const data = join(linked, 'data');
  const db = new Store(data);
  t.after(() => db.close());
  const store = new WorkspaceStore(db.db);
  const project: Project = {
    id: randomUUID(),
    name: 'Removed fixture',
    path: join(linked, 'original'),
    createdAt: '',
    updatedAt: '',
    removedAt: '2026-10-25T00:00:00Z',
  };
  mkdirSync(project.path);
  writeFileSync(join(project.path, 'keep.txt'), 'original contents');
  store.save('project', project.id, project.id, project);
  appendLaneEvent(data, project.id, { at: 'synthetic', type: 'lane-created', lane: 'lane' });
  const events = laneEventsPath(data, project.id);
  assert.equal(existsSync(events), true);
  const purger = new ProjectPurger({
    store,
    dataDir: data,
    assertIdle: () => {},
    quiesce: async () => {},
    purgeMedia: () => {},
    finished: () => {},
  });
  const preview = await purger.preview(project.id);
  assert.equal(preview.canPurge, true, JSON.stringify(preview));
  await purger.purge(project.id, preview.token);
  assert.equal(existsSync(events), false);
  assert.equal(readFileSync(join(project.path, 'keep.txt'), 'utf8'), 'original contents');
});
