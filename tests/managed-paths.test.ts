import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { repairManagedPiTarget } from '../src/server/managed-paths.ts';

const entry = (root: string) =>
  join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-managed-pi-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.split(/[\\/]/).at(-1)?.startsWith('comborunner-managed-pi-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const root = join(directory, 'ComboRunner'),
    oldRoot = join(directory, 'agent-studio'),
    dataDir = join(directory, 'user-data');
  mkdirSync(dirname(entry(root)), { recursive: true });
  writeFileSync(entry(root), 'fixture only');
  const target: RuntimeTarget = {
    id: 'pi-local',
    provider: 'pi',
    label: 'Pi',
    environment: 'native',
    enabled: true,
    command: process.execPath,
    args: [entry(oldRoot), '--session-dir', join(oldRoot, '.data', 'pi', 'sessions')],
  };
  return { directory, root, oldRoot, dataDir, target };
}

test('repairs a vanished default checkout entry and maps only its absent default sessions path', (t) => {
  const { root, oldRoot, dataDir, target } = fixture(t);
  assert.equal(existsSync(oldRoot), false);
  assert.equal(repairManagedPiTarget([target], root, dataDir), true);
  assert.equal(target.command, process.execPath);
  assert.deepEqual(target.args, [entry(root), '--session-dir', join(dataDir, 'pi', 'sessions')]);
  assert.equal(target.commandDiscovery, 'auto');
  assert.equal(repairManagedPiTarget([target], root, dataDir), false);
});

test('retains fixed targets, custom commands, extra arguments and nondefault entry structures', (t) => {
  const { root, dataDir, target, directory } = fixture(t);
  const variants: RuntimeTarget[] = [
    { ...target, commandDiscovery: 'fixed' },
    { ...target, command: join(directory, 'custom', 'node.exe') },
    { ...target, args: [...target.args!, '--custom-option'] },
    { ...target, commandDiscovery: 'auto', args: [...target.args!, '--custom-option'] },
    { ...target, args: [join(directory, 'custom-cli.js'), '--session-dir', target.args![2]] },
    { ...target, id: 'custom-pi' },
    { ...target, environment: 'wsl' },
    { ...target, provider: 'codex' },
  ];
  const originals = structuredClone(variants);
  assert.equal(repairManagedPiTarget(variants, root, dataDir), false);
  assert.deepEqual(variants, originals);
});

test('preserves existing sessions and their content while repairing the entry', (t) => {
  const { root, dataDir, target } = fixture(t);
  const sessions = target.args![2];
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'history.jsonl'), 'historical session');
  assert.equal(repairManagedPiTarget([target], root, dataDir), true);
  assert.equal(target.args![2], sessions);
  assert.equal(existsSync(join(sessions, 'history.jsonl')), true);
});

test('does not relocate an absent custom sessions directory and preserves disabled state', (t) => {
  const { root, dataDir, target, directory } = fixture(t);
  target.enabled = false;
  target.args![2] = join(directory, 'custom-sessions');
  assert.equal(repairManagedPiTarget([target], root, dataDir), true);
  assert.equal(target.args![2], join(directory, 'custom-sessions'));
  assert.equal(target.enabled, false);
});

test('recognizes an old bundled Electron executable and explicitly managed auto targets', (t) => {
  const { root, oldRoot, dataDir, target, directory } = fixture(t);
  target.command = join(oldRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const auto: RuntimeTarget = {
    ...structuredClone(target),
    command: join(directory, 'previous-runtime', 'node'),
    commandDiscovery: 'auto',
  };
  assert.equal(repairManagedPiTarget([target, auto], root, dataDir), true);
  assert.equal(target.command, process.execPath);
  assert.equal(auto.command, process.execPath);
});

test('leaves working old entries and missing replacement installations unchanged', (t) => {
  const { root, oldRoot, dataDir, target, directory } = fixture(t);
  assert.equal(repairManagedPiTarget([target], join(directory, 'not-installed'), dataDir), false);
  mkdirSync(dirname(entry(oldRoot)), { recursive: true });
  writeFileSync(entry(oldRoot), 'fixture only');
  const original = structuredClone(target);
  assert.equal(repairManagedPiTarget([target], root, dataDir), false);
  assert.deepEqual(target, original);
});
