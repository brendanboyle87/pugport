import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// electron-builder's pinned dependency supplies the same YAML parser used for its manifests.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { load } = createRequire(builderRequire.resolve('app-builder-lib'))('js-yaml');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Expected a stable release version (major.minor.patch).');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Release version is out of range.');
  return parts;
}

export function assertNewerVersion(current, previous) {
  const next = versionParts(current);
  const old = versionParts(previous);
  const differing = next.findIndex((part, index) => part !== old[index]);
  if (differing < 0 || next[differing] <= old[differing])
    throw new Error(`Release ${current} must be newer than the published version ${previous}.`);
}

export function assertReleaseHost(platform, gitStatus) {
  if (platform !== 'win32') throw new Error('Windows releases must be built on Windows.');
  if (gitStatus.trim()) throw new Error('Commit or otherwise resolve working-tree changes before releasing.');
}

export async function verifyOutputs(directory, version) {
  versionParts(version);
  const name = `PugPort-Setup-${version}.exe`;
  const files = [name, `${name}.blockmap`, 'latest.yml'].map((name) => {
    const path = join(directory, name);
    const stat = statSync(path);
    if (!stat.isFile() || !stat.size) throw new Error(`Missing or empty release file: ${name}`);
    return { name, path, size: stat.size };
  });
  const manifest = load(readFileSync(files[2].path, 'utf8'));
  if (!manifest || manifest.version !== version) throw new Error('latest.yml version does not match package.json.');
  const entry = manifest.files?.find((file) => file.url === name);
  if (!entry || manifest.path !== name) throw new Error('latest.yml does not reference the expected installer.');
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(files[0].path)) hash.update(chunk);
  const sha512 = hash.digest('base64');
  if (entry.sha512 !== sha512 || manifest.sha512 !== sha512 || entry.size !== files[0].size)
    throw new Error('latest.yml installer hash or size does not match the installer.');
  return files;
}

export function uploadConfiguration(env) {
  const names = ['PUGPORT_R2_ACCOUNT_ID', 'PUGPORT_R2_ACCESS_KEY_ID', 'PUGPORT_R2_SECRET_ACCESS_KEY'];
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing upload environment variables: ${missing.join(', ')}`);
  return {
    endpoint: `https://${env.PUGPORT_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    credentials: {
      accessKeyId: env.PUGPORT_R2_ACCESS_KEY_ID,
      secretAccessKey: env.PUGPORT_R2_SECRET_ACCESS_KEY,
    },
    bucket: env.PUGPORT_R2_BUCKET || 'pugport-downloads',
  };
}

// The small transport contract keeps all network effects testable with a fake client.
export async function uploadRelease({ client, bucket, version, files }) {
  versionParts(version);
  const previous = await client.read(bucket, 'windows/latest.yml');
  if (previous !== undefined) {
    const manifest = load(previous);
    assertNewerVersion(version, manifest?.version);
  }
  const [installer, blockmap, manifest] = files;
  await client.upload(bucket, `windows/${installer.name}`, installer.path, 'application/octet-stream');
  await client.upload(bucket, `windows/${blockmap.name}`, blockmap.path, 'application/octet-stream');
  await client.copy(bucket, `windows/${installer.name}`, 'windows/PugPort-Setup.exe', 'no-cache');
  await client.upload(bucket, 'windows/latest.yml', manifest.path, 'text/yaml', 'no-cache');
}

async function s3Transport(config) {
  const { S3Client, GetObjectCommand, CopyObjectCommand } = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const client = new S3Client(config);
  return {
    async read(Bucket, Key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key }));
        if (!result.Body) throw new Error('Remote manifest has no body.');
        return await result.Body.transformToString();
      } catch (error) {
        if (error.name === 'NoSuchKey') return undefined;
        throw error;
      }
    },
    async upload(Bucket, Key, path, ContentType, CacheControl) {
      await new Upload({
        client,
        params: { Bucket, Key, Body: createReadStream(path), ContentType, CacheControl },
      }).done();
    },
    async copy(Bucket, source, Key, CacheControl) {
      await client.send(
        new CopyObjectCommand({
          Bucket,
          Key,
          CopySource: `${encodeURIComponent(Bucket)}/${source.split('/').map(encodeURIComponent).join('/')}`,
          MetadataDirective: 'REPLACE',
          ContentType: 'application/octet-stream',
          CacheControl,
        }),
      );
    },
    close: () => client.destroy(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--upload') || args.length > 1)
    throw new Error('Usage: npm run release:win [-- --upload]');
  assertReleaseHost(process.platform, '');
  const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assertReleaseHost(process.platform, status);
  const upload = args.includes('--upload') ? uploadConfiguration(process.env) : undefined;
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  versionParts(version);
  run(['scripts/build.mjs']);
  run(['scripts/package.mjs']);
  run([
    require.resolve('electron-builder/cli.js'),
    '--prepackaged',
    'release/PugPort-win32-x64',
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
  ]);
  const files = await verifyOutputs(join(root, 'release', 'installer', version), version);
  for (const file of files) console.log(`${file.name}: ${file.size} bytes`);
  if (upload) {
    let client;
    try {
      client = await s3Transport(upload);
      await uploadRelease({ client, bucket: upload.bucket, version, files });
    } catch {
      // SDK errors may contain request details. Never print credential-bearing diagnostics.
      throw new Error(
        'Upload stopped. Check remote version, network access and bucket permissions; no credentials were logged.',
      );
    } finally {
      client?.close();
    }
    console.log(`Uploaded Windows release ${version}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
