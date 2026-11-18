import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { apiPreset } from '../src/shared/api-providers.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { apiTarget } from '../src/server/api-providers.ts';
import { makePiTarget } from '../src/server/adapters/pi.ts';
import { nativeDiscoveryRuntime } from '../src/server/native-discovery-client.ts';
import { repairManagedPiTarget } from '../src/server/managed-paths.ts';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';

function fixture(t: TestContext, electron = true) {
  const root = mkdtempSync(join(tmpdir(), 'pugport-managed-node-'));
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: electron ? 'fixture' : undefined, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor);
    else Reflect.deleteProperty(process.versions, 'electron');
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.split(/[\\/]/).at(-1)?.startsWith('pugport-managed-node-'));
    rmSync(root, { recursive: true, force: true });
  });
  const node = join(root, '.runtime', 'node.exe');
  mkdirSync(dirname(node));
  writeFileSync(node, 'selection fixture, never executed');
  const entry = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, 'selection fixture, never executed');
  return { root, node, entry, data: join(root, 'data') };
}

test(
  'API and Pi factories use the same installed Windows Node as metadata discovery',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = fixture(t);
    const api = apiTarget(f.root, f.data, apiPreset('deepseek')!, 'api-deepseek', 'DeepSeek');
    const pi = makePiTarget(f.root, f.data);
    assert.equal(api.command, f.node);
    assert.equal(pi.command, f.node);
    assert.equal(nativeDiscoveryRuntime(f.root), f.node);
    assert.deepEqual(api.args, [f.entry, '--session-dir', join(f.data, 'api', 'api-deepseek', 'sessions')]);
    assert.deepEqual(pi.args, [f.entry, '--session-dir', join(f.data, 'pi', 'sessions')]);
    assert.equal(api.agentDir, join(f.data, 'api', 'api-deepseek', 'agent'));
  },
);

test('ordinary Node hosts and absent bundles retain process.execPath', (t) => {
  const f = fixture(t, false);
  assert.equal(apiTarget(f.root, f.data, apiPreset('deepseek')!, 'api-deepseek', 'DeepSeek').command, process.execPath);
  assert.equal(makePiTarget(f.root, f.data).command, process.execPath);
  assert.equal(nativeDiscoveryRuntime(f.root, 'darwin', true), process.execPath);
  assert.equal(nativeDiscoveryRuntime(f.root, 'linux', true), process.execPath);
  assert.equal(nativeDiscoveryRuntime(join(f.root, 'missing'), 'win32', true), process.execPath);
});

test('Electron factories fall back when the installation has no bundled Node', (t) => {
  const f = fixture(t);
  const missing = join(f.root, 'missing');
  assert.equal(
    apiTarget(missing, f.data, apiPreset('deepseek')!, 'api-deepseek', 'DeepSeek').command,
    process.execPath,
  );
  assert.equal(makePiTarget(missing, f.data).command, process.execPath);
});

test(
  'an existing managed Pi entry migrates runtime without changing sessions or options',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = fixture(t);
    const sessions = join(f.root, 'retained-sessions');
    mkdirSync(sessions);
    const history = join(sessions, 'old.jsonl');
    writeFileSync(history, 'synthetic old session');
    for (const commandDiscovery of [undefined, 'auto'] as const) {
      const target: RuntimeTarget = {
        ...makePiTarget(f.root, f.data),
        enabled: false,
        command: join(f.root, 'node_modules', 'electron', 'dist', 'electron.exe'),
        commandDiscovery,
        args: [f.entry, '--session-dir', sessions],
      };
      assert.equal(repairManagedPiTarget([target], f.root, f.data), true);
      assert.equal(target.command, f.node);
      assert.deepEqual(target.args, [f.entry, '--session-dir', sessions]);
      assert.equal(target.enabled, false);
      assert.equal(readFileSync(history, 'utf8'), 'synthetic old session');
      assert.equal(repairManagedPiTarget([target], f.root, f.data), false);
    }
  },
);

test('working custom, fixed and extra-argument Pi launches are not migrated', (t) => {
  const f = fixture(t);
  const base = makePiTarget(f.root, f.data);
  const variants: RuntimeTarget[] = [
    { ...base, command: join(f.root, 'custom.exe'), commandDiscovery: 'fixed' },
    { ...base, command: join(f.root, 'custom.exe'), commandDiscovery: undefined },
    { ...base, command: join(f.root, 'custom.exe'), commandDiscovery: 'auto' },
    { ...base, command: process.execPath, args: [...base.args!, '--custom'] },
  ];
  const before = structuredClone(variants);
  assert.equal(repairManagedPiTarget(variants, f.root, f.data), false);
  assert.deepEqual(variants, before);
});

test('existing Pi runtime migration does not change non-Windows launches', (t) => {
  const f = fixture(t);
  const target = {
    ...makePiTarget(f.root, f.data),
    command: join(f.root, 'node_modules', 'electron', 'dist', 'electron'),
  };
  const before = structuredClone(target);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    assert.equal(repairManagedPiTarget([target], f.root, f.data), false);
    assert.deepEqual(target, before);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('relocated legacy bundled Node targets retain custom session directories', (t) => {
  const f = fixture(t, false);
  const old = join(f.root, 'removed-install');
  const sessions = join(f.root, 'saved-sessions');
  const target: RuntimeTarget = {
    ...makePiTarget(f.root, f.data),
    commandDiscovery: undefined,
    command: join(old, '.runtime', 'node.exe'),
    args: [
      join(old, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'),
      '--session-dir',
      sessions,
    ],
  };
  assert.equal(repairManagedPiTarget([target], f.root, f.data), true);
  assert.equal(target.command, process.execPath);
  assert.deepEqual(target.args, [f.entry, '--session-dir', sessions]);
  assert.equal(existsSync(sessions), false);
});

test(
  'Controller startup preserves fixed API launch settings while migrating managed factories',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = fixture(t);
    const preset = apiPreset('deepseek')!;
    const managed = apiTarget(f.root, f.data, preset, 'api-managed', 'Managed');
    managed.command = join(f.root, 'node_modules', 'electron', 'dist', 'electron.exe');
    const fixed: RuntimeTarget = {
      ...apiTarget(f.root, f.data, preset, 'api-fixed', 'Fixed'),
      command: join(f.root, 'custom-node.exe'),
      args: ['custom.js', '--session-dir', join(f.root, 'custom-sessions')],
      commandDiscovery: 'fixed',
      enabled: false,
      responseLatencyEpoch: 'preserved-epoch',
    };
    const before = { command: fixed.command, args: fixed.args, commandDiscovery: fixed.commandDiscovery };
    const seed = new Store(f.data);
    seed.setConfig('targets', [managed, fixed]);
    seed.close();
    const controller = new Controller(f.root, f.data);
    clearInterval(controller.timer);
    try {
      const actual = controller.targets.find((target) => target.id === fixed.id)!;
      assert.deepEqual(
        { command: actual.command, args: actual.args, commandDiscovery: actual.commandDiscovery },
        before,
      );
      assert.equal(actual.enabled, false);
      assert.equal(actual.responseLatencyEpoch, 'preserved-epoch');
      assert.equal(controller.targets.find((target) => target.id === managed.id)!.command, f.node);
    } finally {
      await controller.close();
    }
    const reopened = new Store(f.data);
    try {
      const persisted = reopened.config<RuntimeTarget[]>('targets', []);
      assert.equal(persisted.find((target) => target.id === managed.id)!.command, f.node);
      assert.deepEqual(persisted.find((target) => target.id === fixed.id)!.args, before.args);
    } finally {
      reopened.close();
    }
  },
);
