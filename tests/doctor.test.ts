import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Standalone diagnostic script has no TypeScript declaration.
import { inspectEnvironment } from '../scripts/doctor.mjs';
const artifacts = [
  'dist/server/main.js',
  'dist/server/bootstrap.js',
  'dist/electron/main.cjs',
  'dist/electron/preload.cjs',
  'dist/ui/index.html',
];
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'pugport-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file: string, content = 'synthetic') => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  put('package.json', JSON.stringify({ name: 'fixture', version: '1.0', type: 'module' }));
  put('node_modules/electron/package.json', '{}');
  put('node_modules/electron/path.txt', 'electron.exe');
  put('node_modules/electron/dist/electron.exe');
  for (const file of artifacts) put(file);
  return {
    root,
    put,
    inspect: (extra = {}) => inspectEnvironment({ root, env: {}, nodeVersion: 'v24.0.0', ...extra }),
  };
}
test('doctor accepts complete installation without executing dependencies or creating data', async (t) => {
  const f = fixture(t);
  f.put('node_modules/electron/index.js', "throw new Error('must never execute');");
  const result = await f.inspect();
  assert.equal(result.built, true);
  assert.equal(result.desktopRuntimeInstalled, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.dataDirectory, join(f.root, '.data'));
  assert.equal(existsSync(result.dataDirectory), false);
});
test('doctor requires every desktop, server bootstrap and UI artifact', async (t) => {
  const f = fixture(t);
  for (const file of artifacts) {
    rmSync(join(f.root, file));
    const result = await f.inspect();
    assert.equal(result.built, false);
    assert.ok(result.missing.includes(file));
    f.put(file);
  }
});
test('doctor checks executable and rejects unsafe marker paths', async (t) => {
  const f = fixture(t);
  rmSync(join(f.root, 'node_modules/electron/dist/electron.exe'));
  assert.equal((await f.inspect()).desktopRuntimeInstalled, false);
  for (const marker of ['../outside.exe', 'C:\\outside.exe', '\\\\host\\share\\electron.exe', '/outside.exe', '']) {
    f.put('node_modules/electron/path.txt', marker);
    assert.equal((await f.inspect()).desktopRuntimeInstalled, false);
  }
});
test('doctor honors data and root environment precedence without writes or secret dumping', async (t) => {
  const f = fixture(t);
  const cwd = join(f.root, 'other');
  const result = await f.inspect({
    cwd,
    env: { COMBORUNNER_DATA_DIR: 'chosen', AGENT_STUDIO_DATA_DIR: 'ignored', API_SECRET: 'never-print-secret' },
  });
  assert.equal(result.dataDirectory, resolve(cwd, 'chosen'));
  assert.equal(result.dataDirectorySource, 'COMBORUNNER_DATA_DIR');
  assert.equal(existsSync(result.dataDirectory), false);
  assert.equal(JSON.stringify(result).includes('never-print-secret'), false);
  assert.equal(
    (await f.inspect({ cwd, env: { AGENT_STUDIO_DATA_DIR: 'legacy' } })).dataDirectory,
    resolve(cwd, 'legacy'),
  );
  assert.equal(
    (await f.inspect({ cwd, env: { COMBORUNNER_ROOT: 'source' } })).dataDirectory,
    resolve(cwd, 'source/.data'),
  );
  assert.equal((await f.inspect({ cwd })).dataDirectory, join(f.root, '.data'));
});
test('doctor missing required build produces JSON and nonzero CLI exit', async (t) => {
  const f = fixture(t);
  f.put('scripts/doctor.mjs');
  copyFileSync(fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url)), join(f.root, 'scripts/doctor.mjs'));
  mkdirSync(join(f.root, 'src/shared'), { recursive: true });
  mkdirSync(join(f.root, 'src/server/platform'), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL('../src/server/platform/under-test.mjs', import.meta.url)),
    join(f.root, 'src/server/platform/under-test.mjs'),
  );
  copyFileSync(
    fileURLToPath(new URL('../src/server/platform/under-test.ts', import.meta.url)),
    join(f.root, 'src/server/platform/under-test.ts'),
  );
  copyFileSync(
    fileURLToPath(new URL('../src/shared/data-location.ts', import.meta.url)),
    join(f.root, 'src/shared/data-location.ts'),
  );
  rmSync(join(f.root, 'dist/server/bootstrap.js'));
  const options = {
    encoding: 'utf8' as const,
    cwd: tmpdir(),
    env: { ...process.env, COMBORUNNER_ROOT: f.root, COMBORUNNER_DATA_DIR: '', AGENT_STUDIO_DATA_DIR: '' },
  };
  const child = spawnSync(process.execPath, [join(f.root, 'scripts/doctor.mjs')], options);
  assert.equal(child.status, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.built, false);
  assert.ok(result.missing.includes('dist/server/bootstrap.js'));
  f.put('.data/data-location.json', '{');
  const brokenLocation = spawnSync(process.execPath, [join(f.root, 'scripts/doctor.mjs')], options);
  assert.equal(brokenLocation.status, 1);
  assert.match(JSON.parse(brokenLocation.stdout).dataDirectoryError, /expected JSON/);
});

test('doctor reports the effective location file and path without creating data', async (t) => {
  const f = fixture(t);
  f.put('relocated/studio.sqlite');
  f.put('.data/data-location.json', JSON.stringify({ dataDir: join(f.root, 'relocated') }));
  const result = await f.inspect();
  assert.equal(result.dataDirectory, join(f.root, 'relocated'));
  assert.equal(result.dataDirectorySource, 'location-file');
  assert.equal(result.dataLocationFile, join(f.root, '.data/data-location.json'));
  assert.equal(existsSync(join(f.root, '.data/studio.sqlite')), false);
});

test('doctor reports malformed locations and stale overrides instead of throwing', async (t) => {
  const f = fixture(t);
  f.put('.data/data-location.json', '{');
  let result = await f.inspect();
  assert.match(result.dataDirectoryError, /expected JSON/);
  assert.ok(result.missing.includes(result.dataDirectoryError));
  assert.equal(result.dataDirectory, undefined);
  f.put('.data/data-location.json', JSON.stringify({ dataDir: join(f.root, 'moved') }));
  result = await f.inspect({ env: { COMBORUNNER_DATA_DIR: join(f.root, '.data') } });
  assert.match(result.dataDirectoryError, /moved to/);
  assert.equal(existsSync(join(f.root, '.data/studio.sqlite')), false);
});

test('doctor CLI prints JSON when the runtime cannot import TypeScript', (t) => {
  const f = fixture(t);
  f.put('scripts/doctor.mjs');
  copyFileSync(fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url)), join(f.root, 'scripts/doctor.mjs'));
  f.put('src/shared/data-location.ts', 'export const resolveDataLocation = () => ({});');
  const child = spawnSync(process.execPath, ['--no-experimental-strip-types', join(f.root, 'scripts/doctor.mjs')], {
    encoding: 'utf8',
    cwd: f.root,
    env: { ...process.env, COMBORUNNER_ROOT: f.root },
  });
  assert.equal(child.status, 1);
  const result = JSON.parse(child.stdout);
  assert.match(result.dataDirectoryError, /Unknown file extension/);
  assert.ok(result.missing.includes(result.dataDirectoryError));
});
