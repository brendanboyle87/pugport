import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  conversationModeManifestSchema,
  MODE_COVER_MAX_BYTES,
  type ConversationModeManifest,
} from '../src/shared/conversation-modes.ts';
import { modeSourceCatalogSchema } from '../src/shared/mode-source.ts';
import { ConversationModes } from '../src/server/conversation-modes.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWMwTptpnDYTAAeZAmUGcC4NAAAAAElFTkSuQmCC';
const webp = 'UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAEAAUAmJaACdLoB+AAETAAA/u+9V/43bjDfgu/33oDeBgAAAA==';
const cover = { src: `data:image/png;base64,${png}`, alt: 'A blue cover' };
const manifest = (): ConversationModeManifest => ({
  schemaVersion: 1,
  id: 'example.presentation',
  version: '1.0.0',
  title: 'Presentation',
  description: 'Fixture',
  view: { fields: [], actions: [] },
});
const accepted = (src: string) =>
  conversationModeManifestSchema.safeParse({ ...manifest(), cover: { ...cover, src } }).success;

test('optional presentation accepts self-contained PNG/WebP, and legacy Mods', () => {
  assert.equal(accepted(cover.src), true);
  assert.equal(accepted(`data:image/webp;base64,${webp}`), true);
  assert.equal(conversationModeManifestSchema.safeParse(manifest()).success, true);
  assert.equal(
    conversationModeManifestSchema.safeParse({ ...manifest(), cover, readme: '# Details\n\nText.' }).success,
    true,
  );
});

test('optional introduction pages allow HTTPS links without credentials and reject executable or private schemes', () => {
  for (const homepage of ['https://example.com/mods/notes', 'https://example.com/guide#intro']) {
    assert.equal(conversationModeManifestSchema.safeParse({ ...manifest(), homepage }).success, true);
    const { view: _view, schemaVersion: _schema, ...metadata } = manifest();
    assert.equal(
      modeSourceCatalogSchema.safeParse({
        schemaVersion: 1,
        mods: [{ ...metadata, homepage, path: 'mods/notes.json', sha256: 'a'.repeat(64) }],
      }).success,
      true,
    );
  }
  for (const homepage of [
    '',
    'not a URL',
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,example',
    'file:///private/notes.html',
    'https://user:secret@example.com',
    'https://user@example.com',
    'https://example.com/' + 'x'.repeat(2000),
  ])
    assert.equal(conversationModeManifestSchema.safeParse({ ...manifest(), homepage }).success, false, homepage);
});

test('cover trust boundary rejects URLs, SVG, bad/noncanonical base64, mismatched MIME, and excess bytes', () => {
  for (const src of [
    'https://example.invalid/cover.png',
    'file:///private/cover.png',
    `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
    `data:image/jpeg;base64,${png}`,
    `data:image/webp;base64,${png}`,
    'data:image/png;base64,!!!!',
    `data:image/png;base64,${png}\n`,
    `data:image/png;base64,${png.slice(0, -1)}`,
    `data:image/webp;base64,${webp.slice(0, -3)}B==`,
    `data:image/png;base64,${Buffer.alloc(MODE_COVER_MAX_BYTES + 1).toString('base64')}`,
  ])
    assert.equal(accepted(src), false, src.slice(0, 80));
  for (const alt of ['', ' '.repeat(3), 'x'.repeat(161)])
    assert.equal(conversationModeManifestSchema.safeParse({ ...manifest(), cover: { ...cover, alt } }).success, false);
});

test('raster headers reject excessive pixel dimensions, animation, and truncated containers', () => {
  for (const [width, height] of [
    [1601, 1],
    [1600, 1000],
    [0, 1],
  ]) {
    const bytes = Buffer.from(png, 'base64');
    bytes.writeUInt32BE(width!, 16);
    bytes.writeUInt32BE(height!, 20);
    assert.equal(accepted(`data:image/png;base64,${bytes.toString('base64')}`), false);
  }
  const pngBytes = Buffer.from(png, 'base64');
  const animatedPng = Buffer.concat([
    pngBytes.subarray(0, -12),
    Buffer.from([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]),
    pngBytes.subarray(-12),
  ]);
  assert.equal(accepted(`data:image/png;base64,${animatedPng.toString('base64')}`), false);
  const webpBytes = Buffer.from(webp, 'base64');
  webpBytes.writeUInt16LE(1601, 26);
  assert.equal(accepted(`data:image/webp;base64,${webpBytes.toString('base64')}`), false);
  const animatedWebp = Buffer.concat([Buffer.from(webp, 'base64'), Buffer.from('ANIM\0\0\0\0', 'binary')]);
  animatedWebp.writeUInt32LE(animatedWebp.length - 8, 4);
  assert.equal(accepted(`data:image/webp;base64,${animatedWebp.toString('base64')}`), false);
  assert.equal(accepted(`data:image/png;base64,${pngBytes.subarray(0, -4).toString('base64')}`), false);
  assert.equal(
    accepted(`data:image/webp;base64,${Buffer.from(webp, 'base64').subarray(0, -4).toString('base64')}`),
    false,
  );
});

test('presentation uses an actual UTF-8 budget while legacy non-ASCII manifests retain their original limit', () => {
  const legacy = manifest();
  legacy.view.fields = Array.from({ length: 16 }, (_, index) => ({
    id: `field${index}`,
    label: 'Field',
    type: 'text',
    initialValue: '学'.repeat(3800),
  }));
  legacy.view.markdown = '学'.repeat(10000);
  assert.ok(Buffer.byteLength(JSON.stringify(legacy)) > 200 * 1024);
  assert.equal(conversationModeManifestSchema.safeParse(legacy).success, true);
  assert.equal(conversationModeManifestSchema.safeParse({ ...legacy, readme: '' }).success, false);
  assert.equal(conversationModeManifestSchema.safeParse({ ...legacy, cover }).success, false);
  assert.equal(conversationModeManifestSchema.safeParse({ ...manifest(), readme: 'x'.repeat(20001) }).success, false);
});

test('local catalog exposes the cover only; full details round-trip and same-version changes remain immutable', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const modes = new ConversationModes({
      store: new WorkspaceStore(db, { recoverInterrupted: false }),
      requireConversation() {
        throw new Error('Unused');
      },
      modeSwitchBarrier: () => undefined,
      notify() {},
    });
    const value = { ...manifest(), cover, readme: '# Details', homepage: 'https://example.com/mods/notes' };
    modes.import(value);
    assert.deepEqual(modes.catalog().catalog[0]?.cover, cover);
    assert.equal(modes.catalog().catalog[0]?.homepage, value.homepage);
    assert.equal('readme' in modes.catalog().catalog[0]!, false);
    assert.deepEqual(modes.export(value.id, value.version), value);
    assert.throws(() => modes.import({ ...value, readme: '# Changed' }), /already exists/);
    const { view: _view, schemaVersion: _schema, readme: _readme, ...metadata } = value;
    const entry = { ...metadata, path: 'mods/example.presentation/1.0.0.json', sha256: 'a'.repeat(64) };
    assert.equal(modeSourceCatalogSchema.safeParse({ schemaVersion: 1, mods: [entry] }).success, true);
    assert.equal(
      modeSourceCatalogSchema.safeParse({ schemaVersion: 1, mods: [{ ...entry, readme: '# Not index metadata' }] })
        .success,
      false,
    );
  } finally {
    db.close();
  }
});
