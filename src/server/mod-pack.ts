import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ZodError } from 'zod';
import { MOD_PACKAGE_MAX_BYTES, modManifestSchema, type ModManifest } from '../shared/mods-manifest.ts';
import { trustedDirectory } from './platform/trusted-path.ts';

/**
 * Author layout ⇄ packaged Mod JSON, shared by `npm run mods:pack`, `mods:validate` and the mod_load bridge tool.
 * Reads regular files only and never runs anything from the folder (no package.json scripts).
 */

export function formatIssues(error: ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || 'manifest'}: ${issue.message}`);
}

export function modWarnings(manifest: ModManifest): string[] {
  if (manifest.schemaVersion !== 2) return [];
  return Object.entries(manifest.ui?.entries ?? {}).flatMap(([key, entry]) =>
    /\son[a-z]+\s*=/i.test(entry.html)
      ? [`warn: ui.entries.${key}.html: inline event handler — not executed in the Mod frame`]
      : [],
  );
}

/** The package is invalid; `issues` carry field paths such as `state.keys: …`. */
export class ModPackError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('\n'));
  }
}

/**
 * Reject a replaced root before reading or writing anything through it. Links above the root (macOS /var, /tmp)
 * belong to the system; the root itself must be the real folder.
 */
export function assertModRoot(dir: string) {
  const root = resolve(dir);
  if (!lstatSync(root).isDirectory() || realpathSync.native(root) !== resolve(trustedDirectory(root)))
    throw new ModPackError(['root: must be a regular directory at its original path']);
}

async function readRegular(path: string, maxBytes: number): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`${path}: must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`${path}: file exceeds ${maxBytes} bytes`);
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error(`${path}: file exceeds ${maxBytes} bytes`);
  return bytes.toString('utf8');
}

async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Packs the author layout in memory; nothing is written. `dev` bumps the patch version of the result. */
export async function packModDirectory(dir: string, options: { dev?: boolean } = {}) {
  assertModRoot(dir);
  const sourcePath = join(dir, 'manifest.json');
  let source: unknown;
  try {
    source = JSON.parse(await readRegular(sourcePath, MOD_PACKAGE_MAX_BYTES));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ModPackError(['manifest.json: file not found']);
    if (error instanceof SyntaxError) throw new ModPackError([`manifest.json: ${error.message}`]);
    throw error;
  }
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new ModPackError(['manifest: expected an object']);
  const manifest = source as Record<string, unknown>;
  if ('ui' in manifest) throw new ModPackError(['ui: manifest.json must not contain ui; use ui/<entry>.html files']);
  const packed = { ...manifest };
  if (options.dev) {
    if (typeof packed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(packed.version)) {
      throw new ModPackError(['version: expected major.minor.patch']);
    }
    const [major, minor, patch] = packed.version.split('.');
    packed.version = `${major}.${minor}.${BigInt(patch) + 1n}`;
  }
  const readmePath = join(dir, 'README.md');
  if (await optionalStat(readmePath)) {
    const readme = await readRegular(readmePath, 20000);
    if (packed.readme === undefined) packed.readme = readme;
  }
  const uiPath = join(dir, 'ui');
  const uiStat = await optionalStat(uiPath);
  if (uiStat) {
    if (!uiStat.isDirectory()) throw new ModPackError(['ui: must be a regular directory']);
    const names = (await readdir(uiPath)).sort();
    const entries: Record<string, { html?: string; css?: string; js?: string }> = Object.create(null);
    let total = 0;
    for (const name of names) {
      const match = /^([a-z][a-z0-9-]{0,31})\.(html|css|js)$/.exec(name);
      if (!match) throw new ModPackError([`ui/${name}: unknown file name; expected <entry>.html, .css or .js`]);
      const [, key, extension] = match;
      if (!entries[key]) entries[key] = {};
      if (Object.keys(entries).length > 6) throw new ModPackError(['ui.entries: at most 6 entries are allowed']);
      const kind = extension as 'html' | 'css' | 'js';
      const text = await readRegular(join(uiPath, name), { html: 128, css: 64, js: 256 }[kind] * 1024);
      total += Buffer.byteLength(text);
      if (total > MOD_PACKAGE_MAX_BYTES) throw new ModPackError(['ui: files exceed 1 MiB combined']);
      entries[key][kind] = text;
    }
    if (names.length) packed.ui = { entries };
  }
  // Validate embedded logo, cover and card data URIs too; their encoded bytes count toward the package budget.
  const parsed = modManifestSchema.safeParse(packed);
  if (!parsed.success) throw new ModPackError(formatIssues(parsed.error));
  const content = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const bytes = Buffer.byteLength(content);
  if (bytes > MOD_PACKAGE_MAX_BYTES) throw new ModPackError(['output: formatted file is larger than 1 MiB']);
  return {
    content,
    bytes,
    sha256: createHash('sha256').update(content).digest('hex'),
    manifest: parsed.data,
    warnings: modWarnings(parsed.data),
    /** The author's manifest.json as read, for writing a dev version bump back. */
    source: manifest,
    sourcePath,
  };
}

/** Writes the bumped version back to manifest.json, only after the whole package validated. */
export async function saveDevVersion(packed: Awaited<ReturnType<typeof packModDirectory>>) {
  assertModRoot(dirname(packed.sourcePath));
  if (!(await lstat(packed.sourcePath)).isFile()) throw new ModPackError(['manifest.json: must be a regular file']);
  await writeFile(
    packed.sourcePath,
    `${JSON.stringify({ ...packed.source, version: packed.manifest.version }, null, 2)}\n`,
    'utf8',
  );
}

/** `mods:pack`: packs and writes `dist/mods/<id>-<version>.json` (or `out`). */
export async function packMod(dir: string, options: { dev?: boolean; out?: string } = {}) {
  let packed: Awaited<ReturnType<typeof packModDirectory>>;
  try {
    packed = await packModDirectory(dir, options);
  } catch (error) {
    // The command line reports plain messages, as before.
    throw error instanceof ModPackError ? new Error(error.message) : error;
  }
  const out = resolve(options.out ?? join('dist', 'mods', `${packed.manifest.id}-${packed.manifest.version}.json`));
  if (out === resolve(packed.sourcePath)) throw new Error('output: must not overwrite manifest.json');
  const outputStat = await optionalStat(out);
  if (outputStat && !outputStat.isFile()) throw new Error('output: must be a regular file');
  // No writes (including --dev's version bump) happen until the complete package is valid.
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, packed.content, 'utf8');
  if (options.dev) await saveDevVersion(packed);
  return {
    path: out,
    bytes: packed.bytes,
    sha256: packed.sha256,
    manifest: packed.manifest,
    warnings: packed.warnings,
  };
}

/**
 * The inverse of packing: `ui.entries` → `ui/<entry>.html|css|js`, `readme` → `README.md`, the rest → manifest.json.
 * Writes into `dir`, which should be empty.
 */
export async function unpackMod(value: unknown, dir: string) {
  const manifest = modManifestSchema.parse(value);
  if (manifest.schemaVersion !== 2) throw new Error('Only schema 2 Mods can be edited in a chat.');
  const { ui, readme, ...rest } = manifest;
  await mkdir(join(dir, 'ui'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(rest, null, 2)}\n`, 'utf8');
  if (readme !== undefined) await writeFile(join(dir, 'README.md'), readme, 'utf8');
  for (const [key, entry] of Object.entries(ui?.entries ?? {}))
    for (const kind of ['html', 'css', 'js'] as const) {
      const text = (entry as Partial<Record<typeof kind, string>>)[kind];
      if (text !== undefined) await writeFile(join(dir, 'ui', `${key}.${kind}`), text, 'utf8');
    }
  return manifest;
}
