import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';

const { verifyLitePackage } = await import(new URL('../scripts/verify-lite-package.mjs', import.meta.url).href);

function fixture(t: TestContext, platform = 'win32') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-lite-package-')));
  t.after(() => {
    const rel = relative(realpathSync.native(tmpdir()), root);
    assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    rmSync(root, { recursive: true, force: true });
  });
  const put = (path: string, text = 'fixture') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const resources = platform === 'darwin' ? 'PugPort.app/Contents/Resources' : 'resources';
  for (const path of [
    ...(platform === 'darwin'
      ? ['PugPort.app/Contents/MacOS/PugPort', 'PugPort.app/Contents/Info.plist']
      : ['PugPort.exe']),
    `${resources}/app/dist/electron/main.cjs`,
    `${resources}/app/package-lock.json`,
    `${resources}/app/LICENSE`,
  ])
    put(path);
  put(`${resources}/app/package.json`, JSON.stringify({ productName: 'PugPort', version: '0.0.30' }));
  return { root, put };
}

test('lightweight package inventory contains the shipped version and files', (t) => {
  const f = fixture(t);
  f.put('resources/app/node_modules/example/fixtures/.env');
  const inventory = verifyLitePackage(f.root);
  assert.equal(inventory.version, '0.0.30');
  assert.equal(inventory.optionalModelsIncluded, false);
  assert.equal(inventory.fileCount, 6);
  assert.ok(inventory.totalBytes > 0);
});

test('Mac lightweight verification accepts the standalone app and rejects optional models inside Resources', (t) => {
  const f = fixture(t, 'darwin');
  assert.equal(verifyLitePackage(join(f.root, 'PugPort.app')).platform, 'darwin');
  assert.equal(verifyLitePackage(f.root).platform, 'darwin');
  f.put('PugPort.app/Contents/Resources/memory-search/model.onnx');
  assert.throws(() => verifyLitePackage(f.root), /Optional component/);
});

test(
  'Mac frameworks can use internal relative links but cannot escape the standalone app',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = fixture(t, 'darwin');
    const bundle = join(f.root, 'PugPort.app');
    const framework = 'PugPort.app/Contents/Frameworks/Fixture.framework';
    f.put(`${framework}/Versions/A/Fixture`);
    symlinkSync('A', join(f.root, framework, 'Versions', 'Current'));
    symlinkSync('Versions/Current/Fixture', join(f.root, framework, 'Fixture'));
    assert.equal(verifyLitePackage(bundle).files.filter((file: { link?: string }) => file.link).length, 2);
    f.put('external-file');
    symlinkSync('../external-file', join(bundle, 'escaped'));
    assert.throws(() => verifyLitePackage(bundle), /escapes distribution/);
    assert.throws(() => verifyLitePackage(f.root), /escapes distribution/);
  },
);

for (const path of [
  'resources/voice/sense-voice/model.int8.onnx',
  'resources/app/.tmp-account.log',
  'resources/app/docs/private.log',
  'resources/app/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/lib.so',
  'resources/app/node_modules/.vite/deps/dev.js',
  'resources/app/node_modules/example/node_modules/.cache/file.json',
]) {
  test(`lightweight package rejects ${path}`, (t) => {
    const f = fixture(t);
    f.put(path);
    assert.throws(
      () => verifyLitePackage(f.root),
      /Optional component|Unexpected application file|Local data|Other-platform|Development cache/,
    );
  });
}
