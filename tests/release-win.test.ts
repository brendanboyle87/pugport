import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  assertNewerVersion,
  assertReleaseHost,
  uploadConfiguration,
  uploadRelease,
  verifyOutputs,
  // @ts-expect-error Release tooling is JavaScript outside the application TypeScript project.
} from '../scripts/release-win.mjs';

const { load } = createRequire(import.meta.url)('js-yaml');

test('installer keeps the permanent desktop identity and per-user data-preserving settings', () => {
  const config = load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../src/electron/taskbar-identity.ts', import.meta.url), 'utf8');
  assert.equal(config.appId, /export const APP_USER_MODEL_ID = '([^']+)'/.exec(source)?.[1]);
  assert.equal(config.appId, 'ComboRunner.App');
  assert.equal(config.productName, 'PugPort');
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.win.publisherName, undefined);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.nsis.createDesktopShortcut, 'always');
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.runAfterFinish, true);
  assert.equal(config.directories.output, 'release/installer/${version}');
  assert.deepEqual(config.publish, { provider: 'generic', url: 'https://download.pugport.com/windows' });
});

test('release guard rejects non-Windows and dirty trees', () => {
  assert.doesNotThrow(() => assertReleaseHost('win32', ''));
  assert.throws(() => assertReleaseHost('linux', ''), /Windows/);
  assert.throws(() => assertReleaseHost('win32', '?? scratch.txt\n'), /working-tree/);
  assert.throws(() => assertReleaseHost('win32', ' M package.json\n'), /working-tree/);
});

test('version guard compares numeric components and rejects equal, older and malformed versions', () => {
  for (const [next, old] of [
    ['1.10.0', '1.9.9'],
    ['2.0.0', '1.99.99'],
    ['0.0.35', '0.0.34'],
  ])
    assert.doesNotThrow(() => assertNewerVersion(next, old));
  for (const [next, old] of [
    ['1.0.0', '1.0.0'],
    ['1.9.0', '1.10.0'],
    ['1.0.0', '2.0.0'],
    ['1.0.0', 'broken'],
    ['1.0.0-rc.1', '0.0.1'],
  ])
    assert.throws(() => assertNewerVersion(next, old));
});

test('output check validates all artifacts, version, hash, size and installer path', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = 'PugPort-Setup-1.2.3.exe';
  const bytes = Buffer.from('synthetic installer; never executable');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  writeFileSync(join(directory, name), bytes);
  writeFileSync(join(directory, `${name}.blockmap`), 'synthetic block map');
  const manifest = { version: '1.2.3', files: [{ url: name, sha512, size: bytes.length }], path: name, sha512 };
  const save = (value: unknown) => writeFileSync(join(directory, 'latest.yml'), JSON.stringify(value));
  save(manifest);
  const files = await verifyOutputs(directory, '1.2.3');
  assert.deepEqual(
    files.map((file: { name: string }) => file.name),
    [name, `${name}.blockmap`, 'latest.yml'],
  );
  for (const changed of [
    { ...manifest, version: '1.2.4' },
    { ...manifest, sha512: 'wrong' },
    { ...manifest, path: 'other.exe' },
    { ...manifest, files: [{ url: name, sha512: 'wrong', size: bytes.length }] },
    { ...manifest, files: [{ url: name, sha512, size: bytes.length + 1 }] },
  ]) {
    save(changed);
    await assert.rejects(verifyOutputs(directory, '1.2.3'));
  }
  save(manifest);
  writeFileSync(join(directory, `${name}.blockmap`), '');
  await assert.rejects(verifyOutputs(directory, '1.2.3'), /empty/);
});

test('upload configuration requires all credentials and uses the default bucket', () => {
  assert.throws(
    () => uploadConfiguration({}),
    /PUGPORT_R2_ACCOUNT_ID.*PUGPORT_R2_ACCESS_KEY_ID.*PUGPORT_R2_SECRET_ACCESS_KEY/,
  );
  const config = uploadConfiguration({
    PUGPORT_R2_ACCOUNT_ID: 'fake',
    PUGPORT_R2_ACCESS_KEY_ID: 'fake-key',
    PUGPORT_R2_SECRET_ACCESS_KEY: 'fake-secret',
  });
  assert.equal(config.bucket, 'pugport-downloads');
  assert.equal(config.endpoint, 'https://fake.r2.cloudflarestorage.com');
});

function transport(previous: string | undefined, fail?: string) {
  const calls: unknown[][] = [];
  const record = async (operation: string, ...args: unknown[]) => {
    calls.push([operation, ...args]);
    if (operation === fail) throw new Error('synthetic failure');
  };
  return {
    calls,
    client: {
      read: async (...args: unknown[]) => {
        await record('read', ...args);
        return previous;
      },
      upload: (...args: unknown[]) => record('upload', ...args),
      copy: (...args: unknown[]) => record('copy', ...args),
    },
  };
}
const artifacts = [
  { name: 'PugPort-Setup-1.2.3.exe', path: 'fake/installer' },
  { name: 'PugPort-Setup-1.2.3.exe.blockmap', path: 'fake/blockmap' },
  { name: 'latest.yml', path: 'fake/manifest' },
];

test('fake S3 publishes versioned artifacts, stable copy and manifest in that order', async () => {
  const { client, calls } = transport('version: 1.2.2');
  await uploadRelease({ client, bucket: 'fake-bucket', version: '1.2.3', files: artifacts });
  assert.deepEqual(calls, [
    ['read', 'fake-bucket', 'windows/latest.yml'],
    ['upload', 'fake-bucket', 'windows/PugPort-Setup-1.2.3.exe', 'fake/installer', 'application/octet-stream'],
    ['upload', 'fake-bucket', 'windows/PugPort-Setup-1.2.3.exe.blockmap', 'fake/blockmap', 'application/octet-stream'],
    ['copy', 'fake-bucket', 'windows/PugPort-Setup-1.2.3.exe', 'windows/PugPort-Setup.exe', 'no-cache'],
    ['upload', 'fake-bucket', 'windows/latest.yml', 'fake/manifest', 'text/yaml', 'no-cache'],
  ]);
});

test('fake S3 supports first publication but refuses stale or unreadable manifests before writing', async () => {
  const first = transport(undefined);
  await uploadRelease({ client: first.client, bucket: 'fake', version: '1.2.3', files: artifacts });
  assert.equal(first.calls.length, 5);
  for (const previous of ['version: 1.2.3', 'version: 1.3.0', 'version: invalid', '']) {
    const fake = transport(previous);
    await assert.rejects(uploadRelease({ client: fake.client, bucket: 'fake', version: '1.2.3', files: artifacts }));
    assert.equal(fake.calls.length, 1);
  }
});

test('fake S3 failures never publish latest.yml', async () => {
  for (const fail of ['read', 'upload', 'copy']) {
    const fake = transport(undefined, fail);
    await assert.rejects(uploadRelease({ client: fake.client, bucket: 'fake', version: '1.2.3', files: artifacts }));
    assert.equal(
      fake.calls.some((call) => call[0] === 'upload' && call[2] === 'windows/latest.yml'),
      false,
    );
  }
});
