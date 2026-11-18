import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const { chooseSmokePort, smokeEnvironment, smokeTargets } = await import(
  new URL('../scripts/smoke-package-isolation.mjs', import.meta.url).href
);

test('package smoke drops inherited credentials and redirects every persistent directory', () => {
  const directory = resolve(tmpdir(), 'pugport-package-smoke-unit');
  const source = {
    SystemRoot: 'C:\\Windows',
    PATH: 'C:\\private-cli',
    OPENAI_API_KEY: 'test-only',
    JEV_API_KEY: 'test-only',
    NODE_OPTIONS: '--require private-hook.cjs',
    ELECTRON_RUN_AS_NODE: '1',
    COMBORUNNER_ROOT: 'private-root',
    PUGPORT_RUNTIME_DIR: 'private-runtime',
    COMBORUNNER_MEMORY_DIR: 'private-memory',
    AGENT_STUDIO_DATA_DIR: 'private-data',
    USERPROFILE: 'private-home',
    APPDATA: 'private-app-data',
  };
  const environment = smokeEnvironment(directory, 45123, source);
  for (const key of [
    'OPENAI_API_KEY',
    'JEV_API_KEY',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'COMBORUNNER_ROOT',
    'AGENT_STUDIO_DATA_DIR',
  ])
    assert.equal(environment[key], undefined, `${key} must not leak into the child`);
  assert.equal(environment.COMBORUNNER_PORT, '45123');
  assert.equal(environment.COMBORUNNER_MEMORY_BACKGROUND, '0');
  assert.equal(environment.COMBORUNNER_IMAGE_BACKGROUND, '0');
  assert.ok(!environment.PATH.includes('private-cli'));
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'PUGPORT_RUNTIME_DIR',
    'COMBORUNNER_DATA_DIR',
    'COMBORUNNER_SMOKE_DIR',
    'COMBORUNNER_DESKTOP_USER_DATA_DIR',
    'COMBORUNNER_MEMORY_DIR',
    'COMBORUNNER_MEMORY_VECTORS_DIR',
    'COMBORUNNER_IMAGE_INDEX_DIR',
    'COMBORUNNER_EXTENSIONS_DIR',
  ])
    assert.ok(environment[key].startsWith(directory), `${key} must remain inside the disposable directory`);
  assert.equal(environment.PUGPORT_RUNTIME_DIR, join(directory, 'runtime'));
  assert.equal(source.USERPROFILE, 'private-home', 'Parent environment must not change');
});

test('package smoke seeds every native executor, including Cursor, disabled with fixed commands', () => {
  const targets = smokeTargets();
  for (const id of ['codex-native', 'claude-native', 'grok-native', 'cursor-native', 'pi-local'])
    assert.equal(targets.filter((target: { id: string }) => target.id === id).length, 1);
  assert.ok(
    targets.every(
      (target: { enabled: boolean; command: string; commandDiscovery: string }) =>
        target.enabled === false && target.commandDiscovery === 'fixed' && target.command === 'disabled',
    ),
  );
});

test('package smoke uses a dynamically allocated loopback port and refuses an occupied explicit port', async (t) => {
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => occupied.close(() => done())));
  const address = occupied.address();
  assert.ok(address && typeof address !== 'string');
  await assert.rejects(chooseSmokePort(String(address.port)), /refusing to reuse a service/);
  const selected = await chooseSmokePort();
  assert.ok(Number.isSafeInteger(selected) && selected > 0 && selected <= 65535);
  assert.notEqual(selected, address.port);
});

test('package smoke rejects malformed explicit ports', async () => {
  for (const value of ['0', '-1', '65536', '4317.5', 'Infinity', '0x10', 'other'])
    await assert.rejects(chooseSmokePort(value), /between 1 and 65535/);
});
