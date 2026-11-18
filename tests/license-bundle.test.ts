import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const licenseText = 'Synthetic fixture license text. This is test-only material, not a distribution license.\n';
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const writeJson = (path: string, value: unknown) => write(path, JSON.stringify(value, null, 2));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-license-bundle-'));
  const source = join(directory, 'source'),
    packaged = join(directory, 'package'),
    app = join(packaged, 'resources', 'app');
  const script = join(directory, 'source', 'scripts', 'verify-license-bundle.mjs');
  t.after(() => {
    const absolute = realpathSync(directory),
      temporary = realpathSync(tmpdir()),
      rel = relative(temporary, absolute);
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    assert.ok(basename(absolute).startsWith('comborunner-license-bundle-'));
    assert.equal(lstatSync(directory).isSymbolicLink(), false);
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  mkdirSync(dirname(script), { recursive: true });
  cpSync(join(repository, 'scripts', 'verify-license-bundle.mjs'), script);
  cpSync(join(repository, 'scripts', 'package-policy.mjs'), join(dirname(script), 'package-policy.mjs'));
  const npmFile = { path: 'licenses/npm/synthetic-addon/LICENSE', sha256: digest(licenseText) };
  writeJson(join(source, 'package.json'), { name: 'synthetic-release', version: '0.0.8' });
  writeJson(join(source, 'package-lock.json'), {
    name: 'synthetic-release',
    version: '0.0.8',
    lockfileVersion: 3,
    packages: {
      '': { name: 'synthetic-release', version: '0.0.8', dependencies: { 'synthetic-addon': '1.2.3' } },
      'node_modules/synthetic-addon': { version: '1.2.3' },
    },
  });
  writeJson(join(source, 'node_modules/synthetic-addon/package.json'), { name: 'synthetic-addon', version: '1.2.3' });
  writeJson(join(source, 'docs/NPM-LICENSE-SUPPLEMENTS.json'), {
    unresolved: [],
    components: [{ name: 'synthetic-addon', licenseFiles: [npmFile] }],
  });
  writeJson(join(source, 'docs/DEPENDENCY-LICENSES.json'), {
    projectVersion: '0.0.8',
    packages: [
      {
        name: 'synthetic-addon',
        version: '1.2.3',
        path: 'node_modules/synthetic-addon',
        developmentOnly: false,
        licenseFiles: [],
        supplementalLicenseFiles: [npmFile.path],
      },
    ],
  });
  write(join(source, npmFile.path), licenseText);
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) write(join(source, name), licenseText);
  mkdirSync(app, { recursive: true });
  for (const path of [
    'package.json',
    'package-lock.json',
    'node_modules',
    'docs',
    'licenses',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    cpSync(join(source, path), join(app, path), { recursive: true });
  }
  for (const path of ['LICENSE', 'LICENSES.chromium.html']) write(join(packaged, path), licenseText);
  const alias = join(directory, 'source-alias');
  symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasScript = join(alias, 'scripts', 'verify-license-bundle.mjs');
  const run = (mode: 'source' | 'package', entry = script, packageDirectory = packaged) =>
    spawnSync(process.execPath, [entry, ...(mode === 'package' ? ['--package', packageDirectory] : [])], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
  return {
    source,
    packaged,
    app,
    aliasScript,
    run,
    rootFor: (mode: 'source' | 'package') => (mode === 'source' ? source : app),
  };
}

test('standalone Mac bundle retains Electron and dependency license materials when copied without the output folder', (t) => {
  const f = fixture(t);
  const bundle = join(f.packaged, 'PugPort.app');
  const resources = join(bundle, 'Contents', 'Resources');
  mkdirSync(resources, { recursive: true });
  cpSync(f.app, join(resources, 'app'), { recursive: true });
  write(join(resources, 'LICENSE.electron.txt'), licenseText);
  write(join(resources, 'LICENSES.chromium.html'), licenseText);
  assert.equal(f.run('package', undefined, bundle).status, 0);
  rmSync(join(resources, 'LICENSE.electron.txt'));
  const result = f.run('package', undefined, bundle);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});

for (const mode of ['source', 'package'] as const) {
  test(`offline license gate discovers actual license text for a locked optional native package absent at audit in ${mode}`, (t) => {
    const f = fixture(t),
      root = f.rootFor(mode);
    const path = 'node_modules/@fixture/native';
    const lock = readJson(join(root, 'package-lock.json'));
    lock.packages[path] = { version: '1.0.0', optional: true };
    writeJson(join(root, 'package-lock.json'), lock);
    const inventory = readJson(join(root, 'docs/DEPENDENCY-LICENSES.json'));
    inventory.packages.push({
      name: '@fixture/native',
      path,
      version: '1.0.0',
      developmentOnly: false,
      optional: true,
      installedAtAudit: false,
      licenseFiles: [],
      supplementalLicenseFiles: [],
    });
    writeJson(join(root, 'docs/DEPENDENCY-LICENSES.json'), inventory);
    writeJson(join(root, path, 'package.json'), { name: '@fixture/native', version: '1.0.0' });
    write(join(root, path, 'LICENSE'), licenseText);
    assert.equal(f.run(mode).status, 0);
    rmSync(join(root, path, 'LICENSE'));
    assert.match(f.run(mode).stderr, /No license text/);
  });
  test(`offline license gate validates and rejects ${mode} material through a directory alias`, (t) => {
    const f = fixture(t);
    let result = f.run(mode, f.aliasScript);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).packaged, mode === 'package');
    write(join(f.rootFor(mode), 'licenses/npm/synthetic-addon/LICENSE'), licenseText + 'Changed material.\n');
    result = f.run(mode, f.aliasScript);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /License digest mismatch/);
  });

  test(`offline license gate accepts complete ${mode} material without network or real binaries`, (t) => {
    const f = fixture(t),
      result = f.run(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      projectVersion: '0.0.8',
      runtimePackages: 1,
      npmSupplementComponents: 1,
      unresolved: 0,
      packaged: mode === 'package',
    });
  });

  test(`offline license gate rejects a newly locked dependency omitted from the ${mode} inventory`, (t) => {
    const f = fixture(t),
      path = join(f.rootFor(mode), 'package-lock.json'),
      lock = readJson(path);
    lock.packages['node_modules/new-addon'] = { version: '2.0.0', optional: true };
    writeJson(path, lock);
    const result = f.run(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Locked dependency missing from license inventory: node_modules\/new-addon/);
  });

  for (const field of ['version', 'developmentOnly'] as const) {
    test(`offline license gate rejects stale ${field} metadata in the ${mode} inventory`, (t) => {
      const f = fixture(t),
        path = join(f.rootFor(mode), 'docs/DEPENDENCY-LICENSES.json'),
        inventory = readJson(path);
      inventory.packages[0][field] = field === 'version' ? '1.2.2' : true;
      writeJson(path, inventory);
      const result = f.run(mode);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`Locked dependency ${field} differs from license inventory`));
    });
  }

  for (const path of [
    'node_modules/unrecorded-addon',
    'node_modules/@fixture/unrecorded-addon',
    'node_modules/synthetic-addon/node_modules/@fixture/unrecorded-addon',
  ]) {
    test(`offline license gate rejects unrecorded installed ${path} in ${mode}`, (t) => {
      const f = fixture(t);
      writeJson(join(f.rootFor(mode), path, 'package.json'), { name: 'unrecorded-addon', version: '3.0.0' });
      write(join(f.rootFor(mode), path, 'LICENSE'), licenseText);
      const result = f.run(mode);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`Installed dependency missing from locked license inventory: ${path}`));
    });
  }

  test(`offline license gate accepts covered nested ${mode} packages and absent optional platform packages`, (t) => {
    const f = fixture(t),
      root = f.rootFor(mode),
      lockPath = join(root, 'package-lock.json'),
      inventoryPath = join(root, 'docs/DEPENDENCY-LICENSES.json'),
      lock = readJson(lockPath),
      inventory = readJson(inventoryPath),
      nested = 'node_modules/synthetic-addon/node_modules/@fixture/nested-addon',
      optional = 'node_modules/@fixture/other-platform';
    for (const path of [nested, optional]) {
      lock.packages[path] = { version: '4.0.0', ...(path === optional ? { optional: true, os: ['aix'] } : {}) };
      inventory.packages.push({
        name: path === nested ? '@fixture/nested-addon' : '@fixture/other-platform',
        path,
        version: '4.0.0',
        developmentOnly: false,
        licenseFiles: path === nested ? [`${path}/LICENSE`] : [],
        supplementalLicenseFiles: [],
      });
    }
    writeJson(lockPath, lock);
    writeJson(inventoryPath, inventory);
    writeJson(join(root, nested, 'package.json'), { name: '@fixture/nested-addon', version: '4.0.0' });
    write(join(root, nested, 'LICENSE'), licenseText);
    let result = f.run(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runtimePackages, 2);
    rmSync(join(root, nested, 'LICENSE'));
    result = f.run(mode);
    assert.equal(result.status, 1, 'installed nested packages still require their recorded license files');
    assert.match(result.stderr, /ENOENT/);
  });

  test(`offline license gate rejects a missing npm license in ${mode}`, (t) => {
    const f = fixture(t);
    rmSync(join(f.rootFor(mode), 'licenses/npm/synthetic-addon/LICENSE'));
    const result = f.run(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
  });

  test(`offline license gate rejects tampered license bytes in ${mode}`, (t) => {
    const f = fixture(t);
    write(join(f.rootFor(mode), 'licenses/npm/synthetic-addon/LICENSE'), licenseText + 'Changed material.\n');
    const result = f.run(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /License digest mismatch/);
  });
}

test('importing the license checker through an alias stays quiet until its API is called explicitly', (t) => {
  const f = fixture(t);
  const importer = join(f.source, 'scripts', 'import-license-checker.mjs');
  write(
    importer,
    `const { verifyLicenseBundle } = await import(${JSON.stringify(pathToFileURL(f.aliasScript).href)});
const result = verifyLicenseBundle({ root: ${JSON.stringify(f.source)} });
console.log(JSON.stringify({ imported: true, unresolved: result.unresolved }));
`,
  );
  const result = spawnSync(process.execPath, [importer], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { imported: true, unresolved: 0 });
});

for (const path of ['LICENSE', 'LICENSES.chromium.html']) {
  test(`packaged gate still requires Electron distribution material: ${path}`, (t) => {
    const f = fixture(t);
    rmSync(join(f.packaged, path));
    const result = f.run('package');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(f.run('source').status, 0, 'source validation does not depend on packaged Electron');
  });
}

test('source gate ignores retired local gateway caches while packaged gate rejects bundling them', (t) => {
  const f = fixture(t);
  write(join(f.source, '.runtime/magpie/magpie-cli.exe'), 'Dormant local cache is not a dependency.\n');
  assert.equal(f.run('source').status, 0);
  write(join(f.packaged, 'resources/magpie/magpie-cli.exe'), 'Retired gateway must not be distributed.\n');
  const result = f.run('package');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Retired Magpie gateway must not be bundled/);
});

test('offline license gate rejects stale project or installed dependency versions', (t) => {
  const f = fixture(t),
    packagePath = join(f.source, 'package.json');
  writeJson(packagePath, { name: 'synthetic-release', version: '0.0.9' });
  let result = f.run('source');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale project version/);
  writeJson(packagePath, { name: 'synthetic-release', version: '0.0.8' });
  writeJson(join(f.source, 'node_modules/synthetic-addon/package.json'), { name: 'synthetic-addon', version: '1.2.4' });
  result = f.run('source');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependency version changed/);
});

test('source license gate accepts a shared dependency junction and checks its package license text', (t) => {
  const f = fixture(t);
  const shared = join(dirname(f.source), 'shared-node-modules');
  renameSync(join(f.source, 'node_modules'), shared);
  symlinkSync(shared, join(f.source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const inventoryPath = join(f.source, 'docs/DEPENDENCY-LICENSES.json');
  const inventory = readJson(inventoryPath);
  inventory.packages[0].licenseFiles = ['node_modules/synthetic-addon/LICENSE'];
  inventory.packages[0].supplementalLicenseFiles = [];
  writeJson(inventoryPath, inventory);
  write(join(shared, 'synthetic-addon/LICENSE'), licenseText);
  let result = f.run('source');
  assert.equal(result.status, 0, result.stderr);
  write(join(shared, 'synthetic-addon/LICENSE'), '');
  result = f.run('source');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /License text empty/);
});

test('source license gate rejects nested dependency junctions escaping the shared dependency root', (t) => {
  const f = fixture(t);
  const shared = join(dirname(f.source), 'shared-node-modules');
  const escaped = join(dirname(f.source), 'escaped-addon');
  renameSync(join(f.source, 'node_modules'), shared);
  renameSync(join(shared, 'synthetic-addon'), escaped);
  symlinkSync(shared, join(f.source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(escaped, join(shared, 'synthetic-addon'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run('source');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /License path escapes distribution/);
});

test('packaged license gate rejects an external top-level dependency junction', (t) => {
  const f = fixture(t);
  const shared = join(dirname(f.source), 'shared-node-modules');
  renameSync(join(f.app, 'node_modules'), shared);
  symlinkSync(shared, join(f.app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run('package');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /License path escapes distribution/);
});
