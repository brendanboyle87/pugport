import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import test from 'node:test';
import { conversationModeManifestSchema, MODE_COVER_MAX_BYTES } from '../src/shared/conversation-modes.ts';
import {
  HOST_ICONS,
  MOD_CARD_V2_MAX_BYTES,
  MOD_COVER_V2_MAX_BYTES,
  MOD_LOGO_MAX_BYTES,
  MOD_PACKAGE_MAX_BYTES,
  MOD_STATE_MAX_BYTES,
  modManifestSchema,
  modManifestV2Schema,
  modCatalogMetadataSchema,
  normalizeModManifest,
  validateModeState,
  composeModePrompt,
  validModImage,
  type ModManifestV2,
} from '../src/shared/mods-manifest.ts';

const minimal = (): ModManifestV2 => ({
  schemaVersion: 2,
  id: 'example.contract',
  version: '1.0.0',
  title: 'Notes',
  description: 'Reading notes',
});
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
function png(width = 64, height = 64, colour = 6, targetBytes?: number, transparent = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colour;
  const channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 4 ? 2 : 1;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  if (colour === 3) parts.push(chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])));
  if (transparent) parts.push(chunk('tRNS', Buffer.from([0, 255])));
  parts.push(chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * channels)))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  if (targetBytes) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    parts.splice(parts.length - 1, 0, chunk('tEXt', Buffer.alloc(targetBytes - length - 12)));
  }
  return `data:image/png;base64,${Buffer.concat(parts).toString('base64')}`;
}
const modImage = (src: string) => ({ src, alt: 'Synthetic raster' });
const full = (): ModManifestV2 => ({
  ...minimal(),
  author: 'Author',
  category: 'Notes',
  license: 'MIT',
  icon: 'notebook-pen',
  logo: modImage(png()),
  cover: modImage(png(1280, 720)),
  card: modImage(png(640, 480)),
  readme: '# Reading notes',
  homepage: 'https://example.com/notes',
  permissions: ['chat:read', 'composer:draft'],
  state: { keys: [{ id: 'notes' }] },
  ui: {
    entries: {
      main: { html: '<p>Main</p>', css: 'p { color: red; }', js: 'void 0;' },
      sidebar: { html: '<p>Sidebar</p>' },
    },
  },
  contributions: {
    mainView: { kind: 'web', entry: 'main' },
    sidebarPanel: { kind: 'web', entry: 'sidebar', title: 'Sidebar' },
    rightPanel: {
      kind: 'form',
      title: 'Notes',
      form: {
        markdown: '# Notes',
        fields: [{ id: 'notes', label: 'Notes', type: 'textarea', initialValue: 'Start', help: 'Your notes' }],
        actions: [
          { id: 'save', label: 'Save', type: 'save' },
          { id: 'insert', label: 'Insert', type: 'compose', prompt: 'Read this' },
        ],
      },
    },
  },
});
test('v2 accepts minimal, every field, and a web right panel', () => {
  assert.deepEqual(modManifestV2Schema.parse(minimal()), minimal());
  assert.deepEqual(modManifestV2Schema.parse(full()), full());
  assert.ok(
    modManifestSchema.safeParse({
      ...minimal(),
      ui: { entries: { panel: { html: '' } } },
      contributions: { rightPanel: { kind: 'web', entry: 'panel' } },
    }).success,
  );
});
test('v2 strictly checks metadata, permissions, fields and unique IDs', () => {
  const base = full();
  for (const patch of [
    { extra: true },
    { title: 'a'.repeat(61) },
    { description: 'a'.repeat(201) },
    { permissions: ['chat:send'] },
    { permissions: ['chat:read', 'chat:read'] },
    { state: { keys: Array.from({ length: 33 }, (_, i) => ({ id: `key${i}` })) } },
    { state: { keys: [{ id: 'notes' }, { id: 'notes' }] } },
    { state: { keys: [], maxBytes: 20 } },
    { state: { keys: [{ id: 'other' }] } },
    { homepage: 'http://example.com' },
    { homepage: 'https://user:password@example.com' },
  ])
    assert.equal(modManifestV2Schema.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch));
  const form = base.contributions!.rightPanel!;
  assert.equal(form.kind, 'form');
  if (form.kind !== 'form') throw new Error('Fixture');
  for (const fields of [
    [...form.form.fields, ...form.form.fields],
    [{ ...form.form.fields[0], label: 'x'.repeat(61) }],
  ])
    assert.equal(
      modManifestV2Schema.safeParse({
        ...base,
        contributions: { rightPanel: { ...form, form: { ...form.form, fields } } },
      }).success,
      false,
    );
  assert.equal(
    modManifestV2Schema.safeParse({
      ...base,
      contributions: {
        rightPanel: { ...form, form: { ...form.form, actions: [form.form.actions[0], form.form.actions[0]] } },
      },
    }).success,
    false,
  );
});
test('web entries have bounded UTF-8 assets, valid keys and one reference per slot', () => {
  const web = { kind: 'web' as const, entry: 'panel' };
  for (const patch of [
    { ui: { entries: { Panel: { html: '' } } } },
    { ui: { entries: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`entry${i}`, { html: '' }])) } },
    { ui: { entries: { panel: { html: 'a'.repeat(128 * 1024 + 1) } } } },
    { ui: { entries: { panel: { html: '学'.repeat(45000) } } } },
    { ui: { entries: { panel: { html: '', css: 'x'.repeat(64 * 1024 + 1) } } } },
    { ui: { entries: { panel: { html: '', js: 'x'.repeat(256 * 1024 + 1) } } } },
    { contributions: { mainView: web } },
    { ui: { entries: { panel: { html: '' } } }, contributions: { mainView: web, sidebarPanel: web } },
  ])
    assert.equal(modManifestV2Schema.safeParse({ ...minimal(), ...patch }).success, false);
  assert.ok(
    modManifestV2Schema.safeParse({
      ...minimal(),
      ui: {
        entries: { panel: { html: 'a'.repeat(128 * 1024), css: 'b'.repeat(64 * 1024), js: 'c'.repeat(256 * 1024) } },
      },
    }).success,
  );
});
test('serialized manifest budget includes JSON escaping and UTF-8', () => {
  const value = {
    ...minimal(),
    ui: {
      entries: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `entry${i}`,
          { html: ' '.repeat(128 * 1024), js: ' '.repeat(256 * 1024) },
        ]),
      ),
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > MOD_PACKAGE_MAX_BYTES);
  const parsed = modManifestV2Schema.safeParse(value);
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.message.includes('1 MiB')));
});
test('all 24 host icons pass; filesystem, URL and SVG icons do not', () => {
  assert.equal(HOST_ICONS.length, 24);
  for (const icon of HOST_ICONS) assert.ok(modManifestV2Schema.safeParse({ ...minimal(), icon }).success, icon);
  for (const icon of ['folder', 'https://example.com/icon.png', '<svg/>'])
    assert.equal(modManifestV2Schema.safeParse({ ...minimal(), icon }).success, false);
  assert.equal(conversationModeManifestSchema.shape.icon.safeParse('calendar').success, false);
});
test('logo PNG checks square dimensions, alpha, byte cap, and transparent palettes', () => {
  for (const src of [png(), png(64, 64, 4), png(64, 64, 3, undefined, true), png(64, 64, 6, MOD_LOGO_MAX_BYTES)])
    assert.ok(modManifestV2Schema.safeParse({ ...minimal(), logo: modImage(src) }).success);
  for (const src of [
    png(63, 64),
    png(64, 64, 2),
    png(64, 64, 3),
    png(64, 64, 6, MOD_LOGO_MAX_BYTES + 1),
    png(1280, 720),
    'data:image/svg+xml;base64,PHN2Zy8+',
  ])
    assert.equal(modManifestV2Schema.safeParse({ ...minimal(), logo: modImage(src) }).success, false);
});
test('WebP logo accepts VP8L alpha or VP8X alpha and refuses plain VP8', () => {
  const lossy = Buffer.from(
    'UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAEAAUAmJaACdLoB+AAETAAA/u+9V/43bjDfgu/33oDeBgAAAA==',
    'base64',
  );
  lossy.writeUInt16LE(64, 26);
  lossy.writeUInt16LE(64, 28);
  const lossless = Buffer.from(lossy);
  lossless.write('VP8L', 12);
  lossless[20] = 0x2f;
  lossless.writeUInt32LE(63 | (63 << 14) | 0x10000000, 21);
  const uri = (bytes: Buffer) => `data:image/webp;base64,${bytes.toString('base64')}`;
  assert.ok(validModImage('logo', uri(lossless), MOD_LOGO_MAX_BYTES));
  lossless.writeUInt32LE(63 | (63 << 14), 21);
  assert.equal(validModImage('logo', uri(lossless), MOD_LOGO_MAX_BYTES), false);
  assert.equal(validModImage('logo', uri(lossy), MOD_LOGO_MAX_BYTES), false);
  const extended = Buffer.alloc(18);
  extended.write('VP8X');
  extended.writeUInt32LE(10, 4);
  extended[8] = 0x10;
  extended[12] = 63;
  extended[15] = 63;
  const withAlpha = Buffer.concat([lossy.subarray(0, 12), extended, lossy.subarray(12)]);
  withAlpha.writeUInt32LE(withAlpha.length - 8, 4);
  assert.ok(validModImage('logo', uri(withAlpha), MOD_LOGO_MAX_BYTES));
  withAlpha[20] = 0;
  assert.equal(validModImage('logo', uri(withAlpha), MOD_LOGO_MAX_BYTES), false);
});
test('v2 cover keeps its 120 KiB cap and v1 retains 48 KiB', () => {
  const v1 = {
    schemaVersion: 1,
    id: 'example.cover',
    version: '1.0.0',
    title: 'Cover',
    description: 'Cover',
    view: { fields: [], actions: [] },
  };
  for (const [limit, schema, value] of [
    [MOD_COVER_V2_MAX_BYTES, modManifestV2Schema, minimal()],
    [MODE_COVER_MAX_BYTES, conversationModeManifestSchema, v1],
  ] as const) {
    assert.ok(schema.safeParse({ ...value, cover: modImage(png(1280, 720, 6, limit)) }).success);
    assert.equal(schema.safeParse({ ...value, cover: modImage(png(1280, 720, 6, limit + 1)) }).success, false);
  }
});
test('v2 cards require bounded 4:3 static images, alt text and at most 60 KiB decoded', () => {
  for (const [width, height] of [
    [480, 360],
    [640, 480],
    [1200, 900],
    [1188, 900],
    [1200, 909],
  ]) {
    assert.ok(modManifestV2Schema.safeParse({ ...minimal(), card: modImage(png(width, height)) }).success);
  }
  for (const [width, height] of [
    [479, 360],
    [480, 359],
    [1201, 901],
    [1187, 900],
    [1200, 910],
    [1280, 720],
    [600, 800],
  ]) {
    assert.equal(modManifestV2Schema.safeParse({ ...minimal(), card: modImage(png(width, height)) }).success, false);
  }
  assert.ok(
    modManifestV2Schema.safeParse({ ...minimal(), card: modImage(png(480, 360, 6, MOD_CARD_V2_MAX_BYTES)) }).success,
  );
  assert.equal(
    modManifestV2Schema.safeParse({ ...minimal(), card: modImage(png(480, 360, 6, MOD_CARD_V2_MAX_BYTES + 1)) })
      .success,
    false,
  );
  for (const card of [
    { src: png(480, 360) },
    { src: png(480, 360), alt: ' ' },
    { ...modImage(png(480, 360)), unknown: true },
    modImage('https://example.com/card.png'),
    modImage('data:image/svg+xml;base64,PHN2Zy8+'),
  ]) {
    assert.equal(modManifestV2Schema.safeParse({ ...minimal(), card }).success, false);
  }
  const animated = Buffer.from(png(480, 360).split(',')[1]!, 'base64');
  const acTL = chunk('acTL', Buffer.alloc(8));
  const animatedSrc = `data:image/png;base64,${Buffer.concat([animated.subarray(0, 33), acTL, animated.subarray(33)]).toString('base64')}`;
  assert.equal(validModImage('card', animatedSrc, MOD_CARD_V2_MAX_BYTES), false);
  assert.deepEqual(modCatalogMetadataSchema.parse({ ...minimal(), card: full().card }).card, full().card);
});

test('card bytes count toward the total serialized v2 package budget', () => {
  const card = modImage(png(480, 360, 6, MOD_CARD_V2_MAX_BYTES));
  const value = {
    ...minimal(),
    ui: {
      entries: Object.fromEntries(
        Array.from({ length: 4 }, (_, i) => [`entry${i}`, { html: '', js: ' '.repeat(243 * 1024) }]),
      ),
    },
  };
  assert.ok(modManifestV2Schema.safeParse(value).success);
  const result = modManifestV2Schema.safeParse({ ...value, card });
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some((issue) => issue.message.includes('1 MiB')));
});

test('WebP cards use the same dimension and animation limits as PNG cards', () => {
  const webp = Buffer.from(
    'UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAEAAUAmJaACdLoB+AAETAAA/u+9V/43bjDfgu/33oDeBgAAAA==',
    'base64',
  );
  const uri = () => `data:image/webp;base64,${webp.toString('base64')}`;
  webp.writeUInt16LE(640, 26);
  webp.writeUInt16LE(480, 28);
  assert.ok(validModImage('card', uri(), MOD_CARD_V2_MAX_BYTES));
  webp.writeUInt16LE(639, 28);
  assert.equal(validModImage('card', uri(), MOD_CARD_V2_MAX_BYTES), false);
  webp.write('ANMF', 12);
  assert.equal(validModImage('card', uri(), MOD_CARD_V2_MAX_BYTES), false);
});
test('v1 example normalizes to a form with state keys and only its required permission', () => {
  const raw = JSON.parse(readFileSync(new URL('../docs/examples/mod-manifest.example.json', import.meta.url), 'utf8'));
  const legacy = conversationModeManifestSchema.parse(raw);
  assert.deepEqual(modManifestSchema.parse(raw), legacy);
  const normalized = normalizeModManifest(legacy);
  const { layout: _layout, ...form } = legacy.view;
  assert.deepEqual(normalized.contributions?.rightPanel, { kind: 'form', form });
  assert.deepEqual(
    normalized.state?.keys,
    legacy.view.fields.map(({ id }) => ({ id })),
  );
  assert.deepEqual(normalized.permissions, ['composer:draft']);
  assert.deepEqual(normalizeModManifest({ ...legacy, view: { ...legacy.view, actions: [] } }).permissions, []);
  const wider = {
    ...legacy,
    title: 'x'.repeat(100),
    view: { ...legacy.view, fields: [{ id: 'notes', type: 'text' as const, label: 'x'.repeat(100) }] },
  };
  assert.equal(normalizeModManifest(conversationModeManifestSchema.parse(wider)).title.length, 100);
  const v2 = minimal();
  assert.equal(normalizeModManifest(v2), v2);
});
test('union preserves version-specific field errors; catalogs retain wider v1 metadata', () => {
  const parsed = modManifestSchema.safeParse({ ...minimal(), title: 'x'.repeat(61) });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.deepEqual(parsed.error.issues[0]?.path, ['title']);
  assert.ok(
    modCatalogMetadataSchema.safeParse({
      ...minimal(),
      schemaVersion: 1,
      title: 'x'.repeat(100),
      description: 'x'.repeat(2000),
      author: 'x'.repeat(120),
    }).success,
  );
  assert.equal(modManifestSchema.safeParse({ ...minimal(), schemaVersion: 3 }).success, false);
});
test('v2 state checks declared keys, string values, key count and exact UTF-8 JSON budget', () => {
  const manifest = { ...minimal(), state: { keys: Array.from({ length: 32 }, (_, i) => ({ id: `key${i}` })) } };
  const values = Object.fromEntries(manifest.state.keys.map(({ id }) => [id, '']));
  assert.deepEqual(validateModeState(manifest, values), values);
  assert.throws(() => validateModeState(manifest, { ...values, key32: '' }));
  assert.throws(() => validateModeState(manifest, { other: '' }), /Unknown mode field/);
  assert.throws(() => validateModeState(manifest, { key0: 1 }));
  const overhead = Buffer.byteLength(JSON.stringify({ key0: '' }));
  assert.ok(validateModeState(manifest, { key0: 'x'.repeat(MOD_STATE_MAX_BYTES - overhead) }));
  assert.throws(() => validateModeState(manifest, { key0: 'x'.repeat(MOD_STATE_MAX_BYTES - overhead + 1) }));
  assert.throws(() => validateModeState(manifest, { key0: '学'.repeat(180000) }));
  const panel = full().contributions!.rightPanel!;
  if (panel.kind !== 'form') throw new Error('Fixture');
  assert.equal(composeModePrompt(panel.form, 'insert', { notes: 'My notes' }), 'Read this\n\nNotes:\nMy notes');
});
