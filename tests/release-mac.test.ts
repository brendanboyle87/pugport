import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUCKET,
  WRANGLER,
  archiveName,
  bumpInventoryVersion,
  checkRelease,
  loadSigningKey,
  manifestBytes,
  parseArgs,
  signManifest,
  uploadPlan,
  uploadRelease,
  verifyManifestSignature,
} from '../scripts/release-mac.mjs';

// A throwaway key pair; the real signing key never enters tests.
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const zipBytes = Buffer.from('synthetic archive bytes');
const archive = { sha256: createHash('sha256').update(zipBytes).digest('hex'), size: zipBytes.length };
const releasedAt = '2026-11-14T12:00:00.000Z';

test('the manifest has the agreed field order, URL and no extra bytes', () => {
  const bytes = manifestBytes({ version: '1.2.3', arch: 'arm64', ...archive, releasedAt });
  assert.equal(
    bytes.toString('utf8'),
    `{"version":"1.2.3","url":"https://download.pugport.com/mac/arm64/PugPort-1.2.3-mac-arm64.zip",` +
      `"sha256":"${archive.sha256}","size":${archive.size},"releasedAt":"${releasedAt}"}`,
  );
  assert.equal(archiveName('1.2.3', 'x64'), 'PugPort-1.2.3-mac-x64.zip');
});

test('the signature is one base64 line over the raw manifest bytes and verifies', () => {
  const bytes = manifestBytes({ version: '1.2.3', arch: 'arm64', ...archive, releasedAt });
  const signature = signManifest(bytes, keys.privateKey);
  assert.match(signature, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(signature, 'base64').length, 64);
  assert.ok(verifyManifestSignature(bytes, signature, publicKey));
  assert.ok(verifyManifestSignature(bytes, `${signature}\n`, publicKey));
  // One changed byte, a different key, or junk text all fail.
  const tampered = Buffer.from(bytes.toString('utf8').replace('1.2.3', '1.2.4'));
  assert.equal(verifyManifestSignature(tampered, signature, publicKey), false);
  assert.equal(verifyManifestSignature(bytes, signature), false);
  assert.equal(verifyManifestSignature(bytes, 'not base64!', publicKey), false);
});

test('checkRelease ties the signed manifest to the exact archive', () => {
  const manifest = manifestBytes({ version: '1.2.3', arch: 'arm64', ...archive, releasedAt });
  const signature = signManifest(manifest, keys.privateKey);
  const input = { manifest, signature, archive, version: '1.2.3', arch: 'arm64', publicKey };
  assert.equal(checkRelease(input).sha256, archive.sha256);
  assert.throws(() => checkRelease({ ...input, archive: { ...archive, size: archive.size + 1 } }), /size/);
  assert.throws(() => checkRelease({ ...input, archive: { ...archive, sha256: '0'.repeat(64) } }), /sha256/);
  assert.throws(() => checkRelease({ ...input, version: '1.2.4' }), /version/);
  assert.throws(() => checkRelease({ ...input, arch: 'x64' }), /URL/);
  assert.throws(() => checkRelease({ ...input, publicKey: undefined }), /signature/);
});

test('loadSigningKey rejects keys that do not pair with the shipped public key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-release-key-'));
  try {
    const path = join(directory, 'key.pem');
    writeFileSync(path, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.throws(() => loadSigningKey(path), /does not match/);
    assert.throws(() => loadSigningKey(join(directory, 'missing.pem')), /not found/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('arguments: rehearsal cannot upload or tag, versions are validated', () => {
  assert.deepEqual(parseArgs([]), {
    version: 'patch',
    allowBranch: false,
    upload: false,
    tag: false,
    rehearsal: false,
  });
  assert.equal(parseArgs(['--version', '0.0.900', '--allow-branch']).version, '0.0.900');
  assert.equal(parseArgs(['--version=1.0.0']).version, '1.0.0');
  assert.throws(() => parseArgs(['--version', 'v1']), /X\.Y\.Z/);
  assert.throws(() => parseArgs(['--rehearsal', '--upload']), /rehearsal/);
  assert.throws(() => parseArgs(['--rehearsal', '--tag']), /rehearsal/);
  assert.throws(() => parseArgs(['--uplaod']), /Unknown/);
});

function fakeRelease() {
  const directory = '/release/mac/arm64';
  const manifest = manifestBytes({ version: '1.2.3', arch: 'arm64', ...archive, releasedAt });
  const signature = Buffer.from(signManifest(manifest, keys.privateKey));
  const plan = uploadPlan({ arch: 'arm64', version: '1.2.3', directory });
  return { manifest, signature, plan };
}

test('upload puts the archive, then the signature, then the manifest, with the right headers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-release-upload-'));
  try {
    const manifest = manifestBytes({ version: '1.2.3', arch: 'arm64', ...archive, releasedAt });
    const signature = Buffer.from(signManifest(manifest, keys.privateKey));
    writeFileSync(join(directory, 'latest.json'), manifest);
    const plan = uploadPlan({ arch: 'arm64', version: '1.2.3', directory });
    const calls: string[][] = [];
    const fetched: string[] = [];
    const remote: Record<string, Buffer> = {};
    const result = await uploadRelease({
      plan,
      version: '1.2.3',
      arch: 'arm64',
      publicKey,
      log: () => {},
      run: async (command, args) => {
        assert.equal(command, WRANGLER[0]);
        calls.push(args);
        const key = args[args.indexOf('put') + 1].slice(`${BUCKET}/`.length);
        remote[key] = key.endsWith('.zip') ? zipBytes : key.endsWith('.sig') ? signature : manifest;
      },
      download: async (url) => {
        fetched.push(url);
        const bytes = remote[new URL(url).pathname.slice(1)];
        assert.ok(bytes, `downloaded ${url} before it was uploaded`);
        return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, bytes };
      },
    });
    assert.equal(result.version, '1.2.3');
    assert.deepEqual(
      calls.map((args) => args[args.indexOf('put') + 1]),
      [
        'pugport-downloads/mac/arm64/PugPort-1.2.3-mac-arm64.zip',
        'pugport-downloads/mac/arm64/latest.json.sig',
        'pugport-downloads/mac/arm64/latest.json',
      ],
    );
    for (const args of calls) {
      assert.deepEqual(args.slice(0, 2), ['-y', 'wrangler@4.162.0']);
      assert.ok(args.includes('--remote'));
    }
    const header = (args: string[], name: string) => args[args.indexOf(name) + 1];
    assert.equal(header(calls[0], '--content-type'), 'application/zip');
    assert.match(header(calls[0], '--cache-control'), /max-age=31536000/);
    assert.equal(header(calls[1], '--cache-control'), 'no-cache');
    assert.equal(header(calls[2], '--content-type'), 'application/json');
    assert.equal(header(calls[2], '--cache-control'), 'no-cache');
    assert.ok(fetched.every((url) => url.startsWith('https://download.pugport.com/mac/arm64/')));
    assert.equal(fetched.length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed archive upload stops before the manifest is published', async () => {
  const { plan } = fakeRelease();
  const calls: string[] = [];
  await assert.rejects(
    uploadRelease({
      plan,
      version: '1.2.3',
      arch: 'arm64',
      publicKey,
      log: () => {},
      run: async (_command, args) => {
        calls.push(args[args.indexOf('put') + 1]);
        throw new Error('wrangler failed');
      },
      download: async () => assert.fail('nothing should be read back'),
    }),
    /wrangler failed/,
  );
  assert.deepEqual(calls, ['pugport-downloads/mac/arm64/PugPort-1.2.3-mac-arm64.zip']);
});

test('the public read-back must match: a corrupted archive or stale manifest fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-release-readback-'));
  try {
    const { manifest, signature } = fakeRelease();
    writeFileSync(join(directory, 'latest.json'), manifest);
    const plan = uploadPlan({ arch: 'arm64', version: '1.2.3', directory });
    const serve = (overrides: Record<string, Buffer>) => async (url: string) => {
      const name = url.split('/').pop()!;
      const bytes =
        overrides[name] ?? (name.endsWith('.zip') ? zipBytes : name.endsWith('.sig') ? signature : manifest);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, bytes };
    };
    const base = { plan, version: '1.2.3', arch: 'arm64', publicKey, log: () => {}, run: async () => {} };
    await assert.rejects(
      uploadRelease({ ...base, download: serve({ 'PugPort-1.2.3-mac-arm64.zip': Buffer.from('corrupt') }) }),
      /sha256/,
    );
    const stale = manifestBytes({ version: '1.2.2', arch: 'arm64', ...archive, releasedAt });
    await assert.rejects(uploadRelease({ ...base, download: serve({ 'latest.json': stale }) }), /differs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the license inventory version is the only field a bump changes', () => {
  const before = '{\n  "schemaVersion": 1,\n  "projectVersion": "0.0.34",\n  "packages": []\n}\n';
  assert.equal(bumpInventoryVersion(before, '0.0.35'), before.replace('0.0.34', '0.0.35'));
  assert.throws(() => bumpInventoryVersion('{}', '0.0.35'), /projectVersion/);
});
