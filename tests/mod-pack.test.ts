import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ModPackError, packModDirectory, saveDevVersion, unpackMod } from '../src/server/mod-pack.ts';

const example = resolve('docs/examples/mods/reading-notes');

test('packing refuses a linked root and dev saving refuses a root swapped after packing', async (t) => {
  const base = await temp(t);
  const root = join(base, 'root');
  const saved = join(base, 'saved');
  const target = join(base, 'target');
  await mkdir(root);
  await mkdir(target);
  const manifest = (await packModDirectory(example)).manifest;
  await unpackMod(manifest, root);
  await unpackMod(manifest, target);
  const before = await readFile(join(target, 'manifest.json'), 'utf8');
  const packed = await packModDirectory(root, { dev: true });
  await rename(root, saved);
  await symlink(target, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packModDirectory(root), /root: must be a regular directory/);
  await assert.rejects(saveDevVersion(packed), /root: must be a regular directory/);
  assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), before);
  assert.equal(await readFile(join(saved, 'manifest.json'), 'utf8'), before);
});

async function temp(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-mod-pack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('pack → unpack → pack reproduces the reading-notes package byte for byte', async (t) => {
  const first = await packModDirectory(example);
  assert.equal(first.manifest.id, 'example.reading-notes');
  assert.equal(first.manifest.schemaVersion, 2);
  const dir = await temp(t);
  await unpackMod(first.manifest, dir);
  assert.deepEqual((await readdir(join(dir, 'ui'))).sort(), ['main.css', 'main.html', 'main.js']);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.equal('ui' in manifest, false, 'the author manifest never holds ui');
  assert.equal('readme' in manifest, false, 'readme goes to README.md');
  assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), first.manifest.readme);
  const second = await packModDirectory(dir);
  assert.equal(second.content, first.content);
  assert.equal(second.sha256, first.sha256);
});

test('an undeclared state key comes back as a field path, and packing writes nothing', async (t) => {
  const dir = await temp(t);
  await unpackMod((await packModDirectory(example)).manifest, dir);
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.contributions.rightPanel = {
    kind: 'form',
    form: { fields: [{ id: 'mood', label: 'Mood', type: 'text' }], actions: [] },
  };
  const before = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path, before);
  const error = await packModDirectory(dir, { dev: true }).catch((failure: unknown) => failure);
  assert.ok(error instanceof ModPackError);
  assert.deepEqual(error.issues, [
    'contributions.rightPanel.form.fields.0.id: Form field must be declared in state.keys',
  ]);
  assert.equal(await readFile(path, 'utf8'), before, 'a failed dev pack keeps the version');
});

test('layout problems are reported as issues, not thrown as crashes', async (t) => {
  const dir = await temp(t);
  await assert.rejects(packModDirectory(dir), (error: unknown) => {
    assert.ok(error instanceof ModPackError);
    assert.deepEqual(error.issues, ['manifest.json: file not found']);
    return true;
  });
  await writeFile(join(dir, 'manifest.json'), '{"ui":{}}');
  await assert.rejects(packModDirectory(dir), /must not contain ui/);
});

test('a JSON-only Mod (no README, html-only entries) unpacks into the author layout and packs back the same', async (t) => {
  const json = {
    schemaVersion: 2,
    id: 'synthetic.timer',
    version: '0.1.3',
    title: 'Timer',
    description: 'A synthetic Mod that only ever existed as JSON.',
    permissions: ['data:store'],
    state: { keys: [{ id: 'minutes' }] },
    ui: { entries: { main: { html: '<p>Timer</p>' }, side: { html: '<p>Side</p>', js: 'console.log(1)' } } },
    contributions: { mainView: { kind: 'web', entry: 'main' }, sidebarPanel: { kind: 'web', entry: 'side' } },
  };
  const dir = await temp(t);
  await unpackMod(json, dir);
  assert.deepEqual((await readdir(join(dir, 'ui'))).sort(), ['main.html', 'side.html', 'side.js']);
  await assert.rejects(readFile(join(dir, 'README.md')), { code: 'ENOENT' }, 'no readme, no README.md');
  const packed = await packModDirectory(dir);
  assert.deepEqual(packed.manifest, json);
  await assert.rejects(
    unpackMod(
      {
        schemaVersion: 1,
        id: 'legacy.notes',
        version: '1.0.0',
        title: 'Old',
        description: 'Legacy',
        view: { markdown: '', fields: [], actions: [] },
      },
      await temp(t),
    ),
    /Only schema 2 Mods/,
  );
});
