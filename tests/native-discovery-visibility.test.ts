import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { showDiscoveredCli } from '../src/shared/runtime-readiness.ts';
import { quotaLines } from '../src/shared/quota-summary.ts';
import { findExecutable } from '../src/server/platform/executables.ts';
import { refreshManagedTargets } from '../src/server/discovery.ts';
import { fakeHost, fakeTree } from './helpers/fake-host.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const providers = ['codex', 'claude', 'grok', 'cursor', 'gemini'] as const;
const targets: RuntimeTarget[] = providers.map((provider) => ({
  id: `${provider}-native`,
  provider,
  label: provider,
  command: provider === 'cursor' ? 'cursor-agent' : provider,
  environment: 'native',
  commandDiscovery: 'auto',
  enabled: true,
}));
function snapshot(
  target: RuntimeTarget,
  status: RuntimeSnapshot['status'],
  installed = status !== 'missing',
): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    installed,
    status,
    models: [],
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    capabilities: { execute: false, resume: false, cancel: false, approvals: false },
    refreshedAt: '2026-10-16T12:00:00Z',
  };
}

for (const platform of ['win32', 'darwin'] as const) {
  test(`${platform}: scanning notices a CLI installed or removed after an earlier scan without executing it`, () => {
    const entries: Record<string, 'exec'> = {};
    const host = fakeHost(platform, { fs: fakeTree(entries) });
    const bin = host.path.join(host.home, 'bin');
    const command = host.path.join(bin, platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent');
    assert.equal(findExecutable('cursor-agent', host), undefined);
    entries[command] = 'exec';
    assert.equal(findExecutable('cursor-agent', host), command);
    delete entries[command];
    assert.equal(findExecutable('cursor-agent', host), undefined);
    entries[command] = 'exec';
    assert.equal(findExecutable('cursor-agent', host), command);
  });

  test(`${platform}: Grok factory discovery follows later installations while preserving user choices`, () => {
    const saved = { ...targets[2]!, commandDiscovery: undefined, enabled: false, executionDisabledByUser: true };
    const next = { ...saved, command: platform === 'win32' ? 'C:\\fixture\\grok.exe' : '/fixture/bin/grok' };
    assert.equal(refreshManagedTargets([saved], [next], platform), true);
    assert.equal(saved.command, next.command);
    assert.equal(saved.commandDiscovery, 'auto');
    assert.equal(saved.enabled, false);
    assert.equal(saved.executionDisabledByUser, true);
    assert.equal(refreshManagedTargets([saved], [{ ...next, command: 'grok' }], platform), true);
    assert.equal(saved.command, 'grok', 'removed binary returns to a discovery slot');
    for (const custom of [
      { ...saved, commandDiscovery: 'fixed' as const },
      { ...saved, args: ['--custom'] },
      { ...saved, id: 'my-grok' },
      { ...saved, commandDiscovery: undefined, command: 'custom-wrapper' },
    ]) {
      const before = structuredClone(custom);
      assert.equal(refreshManagedTargets([custom], [next], platform), false);
      assert.deepEqual(custom, before);
    }
  });
}

test('missing discovery slots are hidden; configured accounts and errors stay visible', () => {
  const target = targets[0]!;
  assert.equal(showDiscoveredCli(target), false);
  assert.equal(showDiscoveredCli(target, snapshot(target, 'missing')), false);
  for (const status of ['ready', 'auth-required', 'unknown', 'error'] as const)
    assert.equal(showDiscoveredCli(target, snapshot(target, status)), true);
  assert.equal(showDiscoveredCli(target, snapshot(target, 'error', false)), true, 'a failed check is not an uninstall');
  assert.equal(
    showDiscoveredCli({ ...target, enabled: false, executionDisabledByUser: true }),
    true,
    'an opted-out account remains available to re-enable after restart',
  );
  for (const configured of [
    { ...target, commandDiscovery: 'fixed' as const },
    { ...target, id: 'my-codex' },
    { ...target, accountId: 'second-account' },
    { ...target, accountHome: '/synthetic/profile' },
    { ...target, gateway: 'api' as const },
    { ...target, args: ['--custom'] },
  ])
    assert.equal(showDiscoveredCli(configured, snapshot(configured, 'missing')), true);
});

test('account list shows discovered status, follows installation changes and keeps the install/scan entry points', async () => {
  const code = await uiBundle('src/ui/Executors.tsx');
  const harness = uiHarness(code);
  const state = {
    app: { platform: 'darwin' },
    targets: structuredClone(targets),
    runtimes: targets.map((target) => snapshot(target, 'missing')),
    settings: {},
  } as unknown as AppState;
  let scans = 0;
  const props = {
    state,
    api: async () => ({ accounts: [] }),
    reload: async () => {},
    notify() {},
    refresh: async () => {
      scans++;
    },
    refreshing: false,
  };
  const render = () => harness.render('ExecutorsPage', props);
  const row = (id: string) => findNode(render(), (node) => node.props.target?.id === id);
  assert.equal(row('cursor-native'), undefined);
  assert.equal(row('gemini-native'), undefined);
  for (const [index, status] of ['ready', 'error', 'auth-required'].entries()) {
    state.runtimes[index] = snapshot(targets[index]!, status as RuntimeSnapshot['status']);
    assert.equal(row(targets[index]!.id)?.props.snapshot.status, status);
  }
  state.runtimes[3] = snapshot(targets[3]!, 'auth-required');
  assert.equal(row('cursor-native')?.props.snapshot.status, 'auth-required', 'a later install appears before login');
  state.runtimes[3] = snapshot(targets[3]!, 'missing');
  assert.equal(row('cursor-native'), undefined, 'uninstalled factory CLI leaves the main list');
  state.runtimes[4] = snapshot(targets[4]!, 'ready');
  assert.equal(row('gemini-native'), undefined, 'even an old ready Gemini snapshot stays hidden');
  assert.equal(state.targets.length, 5, 'display filtering does not mutate configuration');
  const refresh = findNode(
    render(),
    (node) => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.includes('刷新'),
  )!;
  refresh.props.onClick();
  assert.equal(scans, 1);
  const install = findNode(render(), (node) => node.type === 'button' && node.props.children === '安装或连接客户端')!;
  install.props.onClick();
  const dialog = findNode(render(), (node) => node.type?.name === 'ConnectAccounts')!;
  assert.ok(dialog);
  const connect = uiHarness(code);
  const tree = connect.render('ConnectAccounts', { ...props, onClose() {} });
  assert.equal(
    findNode(tree, (node) => node.props.target?.id === 'gemini-native'),
    undefined,
    'retired Gemini CLI has no installation entry point',
  );
  connect.unmount();
  harness.unmount();
});

for (const compact of [false, true])
  test(`${compact ? 'compact' : 'expanded'} quota cards hide missing factory CLIs and follow discovery without dropping custom configuration`, async () => {
    const custom: RuntimeTarget = { ...targets[3]!, id: 'custom-cursor', commandDiscovery: 'fixed' };
    const state = {
      app: { platform: 'darwin' },
      targets: [...structuredClone(targets), custom],
      runtimes: [],
      runs: [],
      settings: {},
    } as unknown as AppState;
    const before = structuredClone(state.targets);
    const harness = uiHarness(await uiBundle('src/ui/UsagePage.tsx'), {
      localStorage: { getItem: () => (compact ? 'compact' : 'expanded'), setItem() {} },
    });
    const props = {
      state,
      now: Date.parse('2026-10-16T12:00:00Z'),
      api: async () => ({}),
      refresh: async () => {},
      refreshing: false,
      notify() {},
      onInspect() {},
    };
    const row = (id: string) => findNode(harness.render('UsagePage', props), (node) => node.props.runtime?.id === id);
    assert.equal(row('cursor-native'), undefined, 'asynchronous startup does not show undiscovered slots');
    assert.equal(row('gemini-native'), undefined);
    state.runtimes = state.targets.map((target) => snapshot(target, 'missing'));
    assert.equal(row('cursor-native'), undefined);
    assert.equal(row('gemini-native'), undefined);
    assert.ok(row(custom.id), 'a configured fixed entry stays visible even while unavailable');
    assert.deepEqual(quotaLines(state.runtimes, state.targets), [], 'the tray omits missing accounts too');

    for (const [index, status] of ['ready', 'error', 'auth-required', 'ready', 'auth-required'].entries()) {
      const target = targets[index]!;
      state.runtimes[index] = snapshot(target, status as RuntimeSnapshot['status']);
      if (target.provider === 'gemini') assert.equal(row(target.id), undefined, 'retired CLI stays hidden');
      else assert.equal(row(target.id)?.props.runtime.status, status, 'newly discovered clients appear before login');
    }
    assert.deepEqual(
      quotaLines(state.runtimes, state.targets).map((line) => line.id),
      targets.filter((target) => target.provider !== 'gemini').map((target) => target.id),
      'tray rows appear after the same discovery update',
    );
    for (const index of [3, 4]) state.runtimes[index] = snapshot(targets[index]!, 'missing');
    assert.equal(row('cursor-native'), undefined, 'uninstall removes the quota card immediately');
    assert.equal(row('gemini-native'), undefined);
    assert.ok(row(custom.id));
    assert.deepEqual(state.targets, before, 'display filtering never deletes discovery or custom configuration');
    harness.unmount();
  });
