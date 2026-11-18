// Fetch immutable upstream source snapshots for inspection only.
// Does not run Git hooks, package scripts, installers, or any downloaded code.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const reports = join(root, 'reports');
const references = [
  {
    name: 'jev-router',
    repository: 'flaviusapop/jev-router',
    commit: '0ada4f883127ea9e5cd0e00521b442ce804b17c9',
    purpose: 'Reference: CLI routing, cross-platform launch adapters and offline tests.',
  },
  {
    name: 'agent-router',
    repository: 'nidhi-singh02/agent-router',
    commit: 'b448dc1fbc5997f11caf317087b5b63c6f50748a',
    purpose: 'Reference: quota-aware routing and native CLI command selection.',
  },
  {
    name: 'CodeyBox',
    repository: 'AdamFrisby/CodeyBox',
    commit: 'd7a9c4fb1221a58ee0026cafbe33d74ec0156008',
    purpose: 'Reference: quota pools and work scheduling; not a local Windows execution dependency.',
  },
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const relativeFile = (path) => relative(root, path).split(sep).join('/');

function inside(base, path) {
  const tail = relative(base, path);
  if (!tail || tail.startsWith(`..${sep}`) || tail === '..' || isAbsolute(tail))
    throw new Error('Archive path escapes its extraction directory.');
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function paxEntries(bytes) {
  const result = {};
  for (let cursor = 0; cursor < bytes.length;) {
    const space = bytes.indexOf(32, cursor);
    if (space < 0) throw new Error('Invalid PAX record.');
    const length = Number(bytes.subarray(cursor, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > bytes.length)
      throw new Error('Invalid PAX record length.');
    const record = bytes.subarray(space + 1, cursor + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    cursor += length;
  }
  return result;
}

/** Extract regular source files, preserving license/notice text verbatim. Links stay in the original archive only. */
async function extractArchive(archive, destination) {
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  let pax = {};
  let globalPax = {};
  let longName;
  let archiveRoot;
  let files = 0;
  let bytes = 0;
  const licenseFiles = [];
  const skippedLinks = [];
  await mkdir(destination, { recursive: true });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = tarString(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Unsupported tar size encoding.');
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error('Invalid tar entry bounds.');
    const storedChecksum = Number.parseInt(tarString(header.subarray(148, 156)).trim(), 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (storedChecksum !== actualChecksum) throw new Error('Tar header checksum mismatch.');
    const content = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const kind = String.fromCharCode(header[156]);
    if (kind === 'x') {
      pax = paxEntries(content);
      continue;
    }
    if (kind === 'g') {
      globalPax = { ...globalPax, ...paxEntries(content) };
      continue;
    }
    if (kind === 'L') {
      longName = tarString(content);
      continue;
    }
    if (kind === 'K') continue; // Long link targets are not materialized.
    const prefix = tarString(header.subarray(345, 500));
    const rawName =
      pax.path ?? globalPax.path ?? longName ?? `${prefix ? prefix + '/' : ''}${tarString(header.subarray(0, 100))}`;
    pax = {};
    longName = undefined;
    if (rawName.includes('\\') || rawName.startsWith('/') || rawName.includes('\0'))
      throw new Error('Unsafe archive name.');
    const parts = rawName.replace(/\/$/, '').split('/');
    if (parts.some((part) => part === '..' || part === '.' || !part || part.includes(':')))
      throw new Error('Unsafe archive path segment.');
    archiveRoot ??= parts[0];
    if (parts[0] !== archiveRoot) throw new Error('Archive must contain exactly one repository root.');
    const relativePath = parts.slice(1).join('/');
    if (!relativePath) continue;
    const path = resolve(destination, ...parts.slice(1));
    inside(destination, path);
    if (kind === '1' || kind === '2') {
      skippedLinks.push(relativePath);
      continue;
    }
    if (kind === '5') {
      await mkdir(path, { recursive: true });
      continue;
    }
    if (kind !== '0' && kind !== '\0') throw new Error(`Unsupported tar entry type ${kind}.`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: 'wx' });
    files++;
    bytes += content.length;
    if (/^(?:licen[cs]e|copying|copyright|notice|third[_-]party[_-]notices?)(?:[._-].*)?$/i.test(parts.at(-1)))
      licenseFiles.push(relativeFile(path));
  }
  if (!files) throw new Error('Source archive contains no files.');
  return { files, extractedBytes: bytes, licenseFiles, skippedLinks };
}

async function fetchArchive(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'pugport-reference-fetch/0.0.1' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Source download failed: HTTP ${response.status}.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024) throw new Error('Source archive exceeds the download limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchReference(reference) {
  const baseName = `${reference.name}-${reference.commit.slice(0, 12)}`;
  const destination = join(vendor, baseName);
  const archivePath = join(vendor, '.archives', `${baseName}.tar.gz`);
  const markerPath = join(vendor, '.manifests', `${baseName}.json`);
  const sourceUrl = `https://github.com/${reference.repository}/tree/${reference.commit}`;
  const archiveUrl = `https://codeload.github.com/${reference.repository}/tar.gz/${reference.commit}`;
  const base = {
    ...reference,
    sourceUrl,
    archiveUrl,
    directory: relativeFile(destination),
    archive: relativeFile(archivePath),
    role: 'source-reference',
    runtimeEnabled: false,
  };
  try {
    const previous = JSON.parse(await readFile(markerPath, 'utf8'));
    if (previous.commit === reference.commit && previous.status === 'downloaded') {
      await stat(destination);
      for (const path of previous.licenseFiles) await stat(resolve(root, path));
      const archive = await readFile(archivePath);
      if (sha256(archive) !== previous.archiveSha256)
        throw new Error('Previously downloaded archive checksum changed.');
      console.log(`${reference.name}: already downloaded (${previous.files} files)`);
      return { ...previous, skippedExisting: true };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Do not overwrite partial/user-modified trees. A failed attempt remains inspectable.
  try {
    await stat(destination);
    throw new Error(`Extraction directory already exists without a valid manifest: ${base.directory}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const archive = await fetchArchive(archiveUrl);
  await writeFile(archivePath, archive);
  const extracted = await extractArchive(archive, destination);
  let license = 'See preserved license files';
  const topLicense = extracted.licenseFiles.find(
    (path) => dirname(path) === base.directory && /\/licen[cs]e(?:\.|$)/i.test(path),
  );
  if (topLicense) {
    const text = await readFile(resolve(root, topLicense), 'utf8');
    if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) license = 'MIT';
    else if (/Apache License[\s\S]{0,80}Version 2\.0/.test(text)) license = 'Apache-2.0';
    else if (/GNU AFFERO GENERAL PUBLIC LICENSE/.test(text)) license = 'AGPL; see exact version in LICENSE';
    else if (/GNU GENERAL PUBLIC LICENSE/.test(text)) license = 'GPL; see exact version in LICENSE';
  }
  if (!extracted.licenseFiles.length)
    throw new Error('No license or notice file found; review the upstream license before use.');
  const result = {
    ...base,
    status: 'downloaded',
    downloadedAt: new Date().toISOString(),
    archiveBytes: archive.length,
    archiveSha256: sha256(archive),
    ...extracted,
    license,
    skippedExisting: false,
  };
  await writeFile(markerPath, JSON.stringify(result, null, 2) + '\n');
  console.log(
    `${reference.name}: ${result.files} files, ${(result.extractedBytes / 1024 / 1024).toFixed(2)} MiB, ${license}`,
  );
  return result;
}

await mkdir(join(vendor, '.archives'), { recursive: true });
await mkdir(join(vendor, '.manifests'), { recursive: true });
await mkdir(reports, { recursive: true });
const settled = await Promise.allSettled(references.map(fetchReference));
const results = settled.map((item, index) =>
  item.status === 'fulfilled'
    ? item.value
    : {
        ...references[index],
        status: 'failed',
        role: 'source-reference',
        runtimeEnabled: false,
        error: item.reason instanceof Error ? item.reason.message : 'Source download failed.',
      },
);
await writeFile(
  join(reports, 'references.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      policy: 'Immutable source snapshots only. No downloaded scripts, packages, or services were run.',
      note: 'All upstream license/notice files in the snapshot are preserved. Symlinks, if any, remain in the complete original archive but are not materialized in the source tree. Submodule repositories and Git LFS object content are not fetched by GitHub source archives.',
      references: results,
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  join(vendor, 'README.md'),
  '# Reference source snapshots\n\nThese fixed upstream commits are for inspection and selective reuse. They are not application dependencies and are not automatically executed. No install or lifecycle scripts were run.\n\nThe complete codeload archives and SHA-256 manifests are retained in `.archives` and `.manifests`. All included LICENSE, NOTICE, and third-party notices remain under each source tree; they apply independently of PugPort’s own license. See `../reports/references.json` for commits, sizes, paths, and any skipped symbolic links. GitHub source archives do not populate Git submodules or fetch Git LFS object contents.\n\nRerun `node scripts/fetch-references.mjs` to verify retained archives and skip completed downloads. It intentionally does not replace existing source trees.\n',
);
const failed = results.filter((item) => item.status === 'failed');
if (failed.length) {
  for (const item of failed) console.error(`${item.name}: ${item.error}`);
  process.exitCode = 1;
}
