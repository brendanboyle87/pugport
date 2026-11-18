import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  copyLocalComponents,
  localComponentsRequested,
  packageIgnore,
  packageTarget,
  packageLayout,
} from '../scripts/package-policy.mjs';

test('desktop target preserves Windows x64 and selects native Mac architecture', () => {
  assert.deepEqual(packageTarget([], { platform: 'win32', arch: 'arm64' }), { platform: 'win32', arch: 'x64' });
  assert.deepEqual(packageTarget([], { platform: 'darwin', arch: 'arm64' }), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(packageTarget(['--platform=darwin', '--arch', 'x64']), { platform: 'darwin', arch: 'x64' });
  assert.throws(() => packageTarget(['--platform=linux']), /Unsupported/);
  assert.throws(() => packageTarget(['--arch']), /Missing/);
});

test('Mac packaging retains matching native modules and rejects other platforms and architectures', () => {
  const target = { platform: 'darwin', arch: 'arm64' };
  for (const path of [
    '/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
    '/node_modules/@img/sharp-darwin-arm64/lib/sharp.node',
    '/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib',
    '/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
    '/node_modules/sherpa-onnx-darwin-arm64/addon.node',
    '/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    '/node_modules/@microsoft/mxc-sdk/LICENSE',
  ])
    assert.equal(packageIgnore(path, target), false, path);
  for (const path of [
    '/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
    '/node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/libonnxruntime.dylib',
    '/node_modules/@img/sharp-win32-x64/lib/sharp.node',
    '/node_modules/@vscode/ripgrep-darwin-x64/bin/rg',
    '/node_modules/sherpa-onnx-win-x64/addon.node',
    '/node_modules/node-pty/prebuilds/linux-arm64/pty.node',
    '/node_modules/@microsoft/mxc-sdk/bin/x64/mxc_ffi.dll',
  ])
    assert.equal(packageIgnore(path, target), true, path);
});

test('Mac local components and layout remain inside the standalone app bundle', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-package-mac-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'output', 'PugPort.app');
  mkdirSync(join(bundle, 'Contents'), { recursive: true });
  const source = join(root, '.runtime', 'memory-search');
  mkdirSync(source, { recursive: true });
  for (const file of ['model.onnx', 'tokenizer.json']) writeFileSync(join(source, file), 'fixture');
  const layout = packageLayout(join(root, 'output'));
  assert.deepEqual(layout, packageLayout(bundle));
  assert.equal(layout.executable, join(bundle, 'Contents', 'MacOS', 'PugPort'));
  assert.deepEqual(copyLocalComponents(root, bundle, { includeComponents: true }), ['memory-search']);
  assert.equal(readFileSync(join(layout.resources, 'memory-search', 'model.onnx'), 'utf8'), 'fixture');
});

test('MXC package filtering preserves Windows x64 runtime and licenses without requiring installation', () => {
  const root = '/node_modules/@microsoft/mxc-sdk/';
  for (const path of [
    'bin/arm64/mxc_ffi.dll',
    'bin/linux/x64/libmxc.so',
    'bin/darwin/arm64/libmxc.dylib',
    'bin/x64/libmxc.so',
    'bin/x64/libmxc.dylib',
    'bin/x64/mxc_test.exe',
    'tests/fixture.exe',
    'bin/x64/mxc.pdb',
  ])
    assert.equal(packageIgnore(root + path), true, path);
  for (const path of [
    'bin/x64/mxc_ffi.dll',
    'bin/x64/mxc.exe',
    'dist/v1/index.js',
    'LICENSE',
    'NOTICE',
    'package.json',
  ])
    assert.equal(packageIgnore(root + path), false, path);
});

test('desktop packaging rejects diagnostics and user data even if they sit at the project root', () => {
  for (const path of [
    '/reports/session.json',
    '/.tmp-claude-auth.json',
    '/.tmp-model-check.log',
    '/credentials.json',
    '/.data/studio.sqlite',
    '/.runtime/voice/model.onnx',
    '/scripts/diagnose-native-cli.ts',
    '/unknown-folder/file.json',
  ])
    assert.equal(packageIgnore(path), true, path);
  for (const path of [
    '/dist/server/main.js',
    '/dist/ui/index.html',
    '/scripts/setup-voice.mjs',
    '/scripts/model-download.mjs',
    '/scripts/runtime-paths.mjs',
    '/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
    '/licenses/npm/provider/LICENSE',
    '/package.json',
  ])
    assert.equal(packageIgnore(path), false, path);
  for (const path of [
    '/node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/onnxruntime.dll',
    '/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/lib.so',
  ])
    assert.equal(packageIgnore(path), true, path);
});

test('desktop packaging omits development caches at every dependency depth', () => {
  for (const path of [
    '/node_modules/.vite',
    '/node_modules/.vite/deps/react.js',
    '/node_modules/.vite-temp/vite.config.mjs',
    '/node_modules/.cache/esbuild/module.bin',
    '/node_modules/provider/node_modules/.cache/build.cache',
    '/node_modules/provider/.turbo/task.json',
    '/node_modules/provider/.parcel-cache/index',
  ])
    assert.equal(packageIgnore(path), true, path);
  assert.equal(packageIgnore('/node_modules/provider/dist/cache.js'), false);
  assert.equal(packageIgnore('/node_modules/provider/dist/.cache-independent-data.json'), false);
});

test('lightweight packaging never includes already-downloaded models without an explicit opt-in', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-package-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, '.runtime', 'memory-search');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'model.onnx'), 'model');
  writeFileSync(join(source, 'tokenizer.json'), '{}');
  const output = join(root, 'output');
  assert.deepEqual(copyLocalComponents(root, output), []);
  assert.equal(existsSync(output), false);
  assert.equal(localComponentsRequested([]), false);
  assert.equal(localComponentsRequested(['--with-local-components']), true);
  assert.deepEqual(copyLocalComponents(root, output, { includeComponents: true }), ['memory-search']);
  assert.equal(readFileSync(join(output, 'resources', 'memory-search', 'model.onnx'), 'utf8'), 'model');
});

test('offline packaging rejects interrupted components instead of publishing broken model installations', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-package-incomplete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = join(root, '.runtime', 'voice', 'sense-voice', 'model.int8.onnx');
  mkdirSync(dirname(model), { recursive: true });
  writeFileSync(model, 'incomplete');
  assert.throws(() => copyLocalComponents(root, join(root, 'out'), { includeComponents: true }), /Incomplete/);
});

test('retired component installers and runtimes never enter new packages', (t) => {
  for (const name of [
    'setup-everything.mjs',
    'everything-settings.mjs',
    'setup-embeddinggemma.mjs',
    'embeddinggemma-pack.mjs',
    'embeddinggemma-host.py',
  ])
    assert.equal(packageIgnore('/scripts/' + name), true);
  const root = mkdtempSync(join(tmpdir(), 'pugport-package-retired-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['everything', 'embeddinggemma']) {
    mkdirSync(join(root, '.runtime', name), { recursive: true });
    writeFileSync(join(root, '.runtime', name, 'keep.txt'), 'synthetic leftover');
  }
  assert.deepEqual(copyLocalComponents(root, join(root, 'out'), { includeComponents: true }), []);
  assert.equal(readFileSync(join(root, '.runtime', 'everything', 'keep.txt'), 'utf8'), 'synthetic leftover');
});
