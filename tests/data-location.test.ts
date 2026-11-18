import { productionPaths } from './helpers/production-paths.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { resolveDataLocation } from '../src/shared/data-location.ts';
import { desktopDataDirectory } from '../src/electron/data-directory.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pugport-data-location-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'outside data');
  mkdirSync(target);
  writeFileSync(join(target, 'studio.sqlite'), 'synthetic');
  mkdirSync(join(root, '.data'));
  const file = join(root, '.data', 'data-location.json');
  const put = (dataDir: unknown = target) => writeFileSync(file, JSON.stringify({ dataDir }));
  const select = (env: NodeJS.ProcessEnv = {}) => productionPaths(() => resolveDataLocation({ root, env }));
  return { root, target, file, put, select };
}

test('source location file selects existing data; both environment overrides win without reading the file', (t) => {
  const f = fixture(t);
  f.put();
  assert.deepEqual(f.select(), { dataDir: f.target, source: 'location-file', locationFile: f.file });
  assert.equal(
    productionPaths(() => desktopDataDirectory({ root: f.root, appData: f.root, env: {}, packaged: false })),
    f.target,
  );
  writeFileSync(f.file, 'invalid JSON');
  const explicit = join(f.root, 'explicit');
  assert.equal(f.select({ COMBORUNNER_DATA_DIR: explicit, AGENT_STUDIO_DATA_DIR: 'ignored' }).dataDir, explicit);
  assert.equal(f.select({ AGENT_STUDIO_DATA_DIR: explicit }).source, 'AGENT_STUDIO_DATA_DIR');
});

test('Windows PowerShell UTF-8 BOM location files select the existing data directory', (t) => {
  const f = fixture(t);
  writeFileSync(f.file, '\uFEFF' + JSON.stringify({ dataDir: f.target }));
  assert.equal(f.select().dataDir, f.target);
  assert.throws(() => f.select({ COMBORUNNER_DATA_DIR: join(f.root, '.data') }), /moved to/);
});

test('relative, empty, missing and malformed location paths fail instead of falling back', (t) => {
  const f = fixture(t);
  for (const value of ['relative', '', '   ', null, 42, undefined]) {
    f.put(value);
    // undefined uses the fixture default; explicitly omit the property for this case.
    if (value === undefined) writeFileSync(f.file, '{}');
    assert.throws(() => f.select(), /Cannot find PugPort's data folder.*absolute, non-empty dataDir/);
  }
  for (const text of ['{', 'null', '[]']) {
    writeFileSync(f.file, text);
    assert.throws(() => f.select(), /Cannot find PugPort's data folder/);
  }
});

test('missing target, non-directory target and missing database are errors with no target creation', (t) => {
  const f = fixture(t);
  const missing = join(f.root, 'never created');
  f.put(missing);
  assert.throws(() => f.select(), /must contain studio.sqlite/);
  assert.equal(existsSync(missing), false);
  f.put(join(f.target, 'studio.sqlite'));
  assert.throws(() => f.select(), /must contain studio.sqlite/);
  rmSync(join(f.target, 'studio.sqlite'));
  f.put();
  assert.throws(() => f.select(), /must contain studio.sqlite/);
  assert.equal(existsSync(join(f.target, 'studio.sqlite')), false);
  mkdirSync(join(f.target, 'studio.sqlite'));
  assert.throws(() => f.select(), /must contain studio.sqlite/);
});

test('packaged desktop ignores even an invalid source location file and keeps the packaged default', (t) => {
  const f = fixture(t);
  writeFileSync(f.file, 'invalid JSON');
  const appData = join(f.root, 'profiles');
  assert.equal(
    productionPaths(() => desktopDataDirectory({ root: f.root, appData, packaged: true, env: {} })),
    join(appData, 'ComboRunner', 'data'),
  );
});

test('an old repo database produces one warning while the location target still wins', (t) => {
  const f = fixture(t);
  f.put();
  writeFileSync(join(f.root, '.data', 'studio.sqlite'), 'old synthetic');
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  assert.equal(f.select().dataDir, f.target);
  assert.equal(f.select().dataDir, f.target);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /old data is still inside the repo/);
});

test('moved-folder guard rejects stale env overrides and a redirected target before any database creation', (t) => {
  const f = fixture(t);
  f.put();
  for (const name of ['COMBORUNNER_DATA_DIR', 'AGENT_STUDIO_DATA_DIR']) {
    assert.throws(() => f.select({ [name]: join(f.root, '.data') }), /this data folder has moved to/);
    assert.equal(existsSync(join(f.root, '.data', 'studio.sqlite')), false);
  }
  writeFileSync(join(f.target, 'data-location.json'), JSON.stringify({ dataDir: join(f.root, 'next move') }));
  assert.throws(() => f.select(), /this data folder has moved to/);
  assert.throws(
    () => productionPaths(() => resolveDataLocation({ root: f.root, env: {}, packaged: true, defaultDir: f.target })),
    /this data folder has moved to/,
  );
});

test('stale sync scripts fail in English without creating a database in a moved stub', (t) => {
  const f = fixture(t);
  const stub = join(f.root, 'moved-stub');
  mkdirSync(stub);
  writeFileSync(join(stub, 'data-location.json'), JSON.stringify({ dataDir: f.target }));
  for (const script of [
    'scripts/import-grok-history.ts',
    'scripts/migrate-local-memory.ts',
    'scripts/sync-local-memory.ts',
    'scripts/sync-grok-history.ts',
    'src/server/local-memory-cli.ts',
    'scripts/verify-codex-accounts.ts',
    'scripts/verify-grok-accounts.ts',
  ]) {
    const scriptPath = fileURLToPath(new URL('../' + script, import.meta.url));
    const flags = script.includes('verify-codex')
      ? ['--discover']
      : script.includes('verify-grok')
        ? ['--live']
        : [f.root];
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), scriptPath, ...flags], {
      cwd: f.root,
      env: { ...process.env, COMBORUNNER_DATA_DIR: stub },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(child.error, undefined, script);
    assert.equal(child.status, 1, script + child.stderr);
    assert.match(child.stderr, /Cannot find PugPort's data folder/);
    assert.match(child.stderr, /this data folder has moved to/);
    assert.equal(existsSync(join(f.root, '.data', 'studio.sqlite')), false);
  }
});
