// Build, ad-hoc sign, zip and sign the update manifest for one Mac release; upload only with --upload.
// The manifest layout is shared with the in-app updater (src/shared/app-update.ts); do not change it here alone.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DOWNLOAD_ROOT = 'https://download.pugport.com';
export const BUCKET = 'pugport-downloads';
export const WRANGLER = ['npx', '-y', 'wrangler@4.162.0'];
/** Wrangler refuses single uploads above 300 MiB. */
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA53vN/yibIS0yQmsymAP97Hwc+l8LVIupeCTAZx0eP9g=
-----END PUBLIC KEY-----
`;
export const DEFAULT_KEY_PATH = join(homedir(), '.pugport-release', 'update-signing-key.pem');
export const LICENSE_INVENTORY = 'docs/DEPENDENCY-LICENSES.json';
/** Files a version bump changes; restored when a run ends without its release commit. */
export const VERSION_FILES = ['package.json', 'package-lock.json', 'src/shared/identity.ts', LICENSE_INVENTORY];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Packaging refuses a license inventory recorded for another version; only that one field changes. */
export function bumpInventoryVersion(text, version) {
  const field = /^(  "projectVersion": )"[^"]*"(,?)$/m;
  if (!field.test(text)) throw new Error(`projectVersion not found in ${LICENSE_INVENTORY}`);
  return text.replace(field, `$1"${version}"$2`);
}

export function parseArgs(argv) {
  const options = { version: 'patch', allowBranch: false, upload: false, tag: false, rehearsal: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--allow-branch') options.allowBranch = true;
    else if (arg === '--upload') options.upload = true;
    else if (arg === '--tag') options.tag = true;
    else if (arg === '--rehearsal') options.rehearsal = true;
    else if (arg === '--version') options.version = argv[++index] ?? '';
    else if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.version !== 'patch' && !/^\d+\.\d+\.\d+$/.test(options.version))
    throw new Error('--version takes patch or X.Y.Z');
  if (options.rehearsal && (options.upload || options.tag))
    throw new Error('--rehearsal leaves no release commit, so it cannot be combined with --upload or --tag');
  return options;
}

export const archiveName = (version, arch) => `PugPort-${version}-mac-${arch}.zip`;
export const objectKey = (arch, file) => `mac/${arch}/${file}`;
export const publicUrl = (arch, file) => `${DOWNLOAD_ROOT}/${objectKey(arch, file)}`;

/** The exact manifest bytes; key order is part of the format the updater signs and reads. */
export function manifestBytes({ version, arch, sha256, size, releasedAt }) {
  const manifest = { version, url: publicUrl(arch, archiveName(version, arch)), sha256, size, releasedAt };
  return Buffer.from(JSON.stringify(manifest), 'utf8');
}

/** Base64 Ed25519 detached signature over the raw manifest bytes, on one line. */
export function signManifest(bytes, privateKey) {
  return sign(null, bytes, privateKey).toString('base64');
}

export function verifyManifestSignature(bytes, signature, publicKey = RELEASE_PUBLIC_KEY) {
  const text = Buffer.isBuffer(signature) ? signature.toString('utf8') : signature;
  if (!/^[A-Za-z0-9+/]+={0,2}\n?$/.test(text)) return false;
  return verify(null, bytes, createPublicKey(publicKey), Buffer.from(text.trim(), 'base64'));
}

/** Throws unless the manifest is signed by the release key and describes exactly this archive. */
export function checkRelease({ manifest, signature, archive, version, arch, publicKey = RELEASE_PUBLIC_KEY }) {
  if (!verifyManifestSignature(manifest, signature, publicKey)) throw new Error('Manifest signature does not verify');
  const parsed = JSON.parse(manifest.toString('utf8'));
  if (parsed.version !== version) throw new Error(`Manifest version ${parsed.version} is not ${version}`);
  if (parsed.url !== publicUrl(arch, archiveName(version, arch)))
    throw new Error(`Unexpected archive URL ${parsed.url}`);
  if (!/^[0-9a-f]{64}$/.test(parsed.sha256)) throw new Error('Manifest sha256 is not 64 lowercase hex digits');
  if (parsed.sha256 !== archive.sha256) throw new Error('Archive sha256 does not match the manifest');
  if (parsed.size !== archive.size) throw new Error('Archive size does not match the manifest');
  if (Number.isNaN(Date.parse(parsed.releasedAt))) throw new Error('Manifest releasedAt is not a date');
  return parsed;
}

/** Upload order matters: the manifest goes last so it never points at an archive that is not there yet. */
export function uploadPlan({ arch, version, directory }) {
  const archive = archiveName(version, arch);
  return [
    { file: archive, contentType: 'application/zip', cacheControl: 'public, max-age=31536000, immutable' },
    { file: 'latest.json.sig', contentType: 'text/plain; charset=utf-8', cacheControl: 'no-cache' },
    { file: 'latest.json', contentType: 'application/json', cacheControl: 'no-cache' },
  ].map((entry) => ({ ...entry, path: join(directory, entry.file), key: objectKey(arch, entry.file) }));
}

export function wranglerPutArgs(entry) {
  return [
    ...WRANGLER.slice(1),
    'r2',
    'object',
    'put',
    `${BUCKET}/${entry.key}`,
    '--remote',
    '--file',
    entry.path,
    '--content-type',
    entry.contentType,
    '--cache-control',
    entry.cacheControl,
  ];
}

/**
 * Put each object in plan order, then read the public copies back and check them like the updater would.
 * `run(command, args)` and `download(url)` (resolves to { sha256, size, bytes? }) are injected for tests.
 */
export async function uploadRelease({ plan, version, arch, run, download, log = console.log, publicKey }) {
  for (const entry of plan) {
    log(`Uploading ${entry.key}`);
    await run(WRANGLER[0], wranglerPutArgs(entry));
  }
  const [archiveEntry, signatureEntry, manifestEntry] = plan;
  const manifest = (await download(publicUrl(arch, manifestEntry.file), { keep: true })).bytes;
  const signature = (await download(publicUrl(arch, signatureEntry.file), { keep: true })).bytes;
  const archive = await download(publicUrl(arch, archiveEntry.file), { keep: false });
  if (!manifest?.equals(readFileSync(manifestEntry.path)))
    throw new Error('The public latest.json differs from the local one (stale cache or failed upload)');
  return checkRelease({ manifest, signature, archive, version, arch, publicKey });
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Load the signing key and prove it pairs with the public key the app ships, without ever printing it. */
export function loadSigningKey(path) {
  if (!existsSync(path)) throw new Error(`Signing key not found at ${path} (set PUGPORT_UPDATE_SIGNING_KEY)`);
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing key is not an Ed25519 private key');
  const derived = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  if (derived.toString().trim() !== RELEASE_PUBLIC_KEY.trim())
    throw new Error('Signing key does not match the public key the app trusts');
  return key;
}

function sh(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

const output = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();

async function curlDownload(url, { keep }) {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-release-check-'));
  try {
    const file = join(directory, 'download');
    execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--output', file, url]);
    return {
      sha256: await sha256File(file),
      size: statSync(file).size,
      bytes: keep ? readFileSync(file) : undefined,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('Mac releases are built on a Mac.');
  const arch = process.arch;
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported Mac architecture: ${arch}`);

  // 1. Preconditions, all checked before anything changes.
  if (output('git', ['status', '--porcelain'])) throw new Error('The working tree is not clean.');
  const branch = output('git', ['branch', '--show-current']);
  if (branch !== 'main' && !options.allowBranch)
    throw new Error(`Release from main (now on ${branch || 'detached HEAD'}).`);
  const keyPath = process.env.PUGPORT_UPDATE_SIGNING_KEY || DEFAULT_KEY_PATH;
  const privateKey = loadSigningKey(keyPath);
  sh('npm', ['run', 'typecheck']);

  let committed = false;
  try {
    // 2. Version.
    const previous = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    sh(process.execPath, ['scripts/version.mjs', options.version]);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    if (version === previous) throw new Error(`Version is already ${version}.`);
    const inventoryPath = join(root, LICENSE_INVENTORY);
    writeFileSync(inventoryPath, bumpInventoryVersion(readFileSync(inventoryPath, 'utf8'), version));
    if (options.tag && output('git', ['tag', '--list', `v${version}`])) throw new Error(`Tag v${version} exists.`);

    // 3. Build and package for this Mac's architecture.
    sh('npm', ['run', 'build']);
    sh('npm', ['run', 'package:desktop']);
    const app = join(root, 'release', `PugPort-darwin-${arch}`, 'PugPort.app');
    if (!existsSync(join(app, 'Contents', 'MacOS', 'PugPort'))) throw new Error(`No app bundle at ${app}`);

    // 4. Ad-hoc signature for this machine; there is no Developer ID.
    sh('codesign', ['--force', '--deep', '--sign', '-', app]);
    sh('codesign', ['--verify', '--deep', '--strict', app]);

    // 5. Archive.
    const directory = join(root, 'release', 'mac', arch);
    mkdirSync(directory, { recursive: true });
    const archivePath = join(directory, archiveName(version, arch));
    for (const file of [archivePath, join(directory, 'latest.json'), join(directory, 'latest.json.sig')])
      rmSync(file, { force: true });
    sh('ditto', ['-c', '-k', '--keepParent', app, archivePath]);
    const archive = { sha256: await sha256File(archivePath), size: statSync(archivePath).size };

    // 6. Manifest and signature, then check them with the public key the app ships.
    const manifest = manifestBytes({ version, arch, ...archive, releasedAt: new Date().toISOString() });
    const signature = signManifest(manifest, privateKey);
    writeFileSync(join(directory, 'latest.json'), manifest);
    writeFileSync(join(directory, 'latest.json.sig'), signature);
    checkRelease({
      manifest: readFileSync(join(directory, 'latest.json')),
      signature: readFileSync(join(directory, 'latest.json.sig')),
      archive: { sha256: await sha256File(archivePath), size: statSync(archivePath).size },
      version,
      arch,
    });
    console.log(`\nVerified ${archiveName(version, arch)}`);
    console.log(`  size    ${archive.size} bytes`);
    console.log(`  sha256  ${archive.sha256}`);
    console.log('  latest.json signature verifies with the release public key');
    if (archive.size > MAX_UPLOAD_BYTES) console.warn('  WARNING: archive exceeds the 300 MiB Wrangler upload limit');

    // Record the version, so a tag and an upload always refer to committed source.
    if (!options.rehearsal) {
      sh('git', ['add', '--', ...VERSION_FILES]);
      sh('git', ['commit', '-m', `release: PugPort ${version} for Mac`]);
      committed = true;
    }
    if (options.tag) sh('git', ['tag', '-a', `v${version}`, '-m', `PugPort ${version}`]);

    // 8. Upload: archive, then signature, then manifest; read back from the public domain.
    if (options.upload) {
      if (archive.size > MAX_UPLOAD_BYTES) throw new Error('Archive is too large for a Wrangler upload.');
      const checked = await uploadRelease({
        plan: uploadPlan({ arch, version, directory }),
        version,
        arch,
        run: async (command, args) => sh(command, args),
        download: curlDownload,
      });
      console.log(`Published ${checked.url}; public manifest, signature and archive verified.`);
    }
    console.log(`\nArtifacts in ${directory}`);
    if (committed) console.log(`Local commit${options.tag ? ' and tag' : ''} created; nothing was pushed.`);
  } finally {
    if (!committed) {
      // The tree was clean at the start, so only the version bump is undone.
      execFileSync('git', ['checkout', 'HEAD', '--', ...VERSION_FILES], { cwd: root });
      console.log('Version files restored to HEAD.');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`release-mac: ${error.message}`);
    process.exitCode = 1;
  });
}
