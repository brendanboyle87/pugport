import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';
import type { AppState } from '../src/shared/types.ts';

const code = await uiBundle('src/ui/App.tsx');
test('web learning adoption uses HTTP and shows the server refusal', async () => {
  const sandboxCode = await uiBundle('src/ui/SandboxSettings.tsx');
  for (const denied of [false, true]) {
    const calls: any[] = [],
      notices: any[] = [];
    const entry = { id: 'a'.repeat(64), resource: 'C:/synthetic/file', resourceType: 'file', accessType: 'read' };
    const h = uiHarness(sandboxCode, { window: {}, Error });
    const props = {
      status: { available: true, sdkVersion: '1.0.1' },
      settings: {},
      change() {},
      reload: async () => {},
      notify: (notice: unknown) => notices.push(notice),
      api: async (path: string, body: unknown) => {
        if (body) {
          calls.push(plain(body));
          if (denied) throw new Error('放宽安全设置或修改执行命令需要在桌面应用中确认。');
          return { adopted: 1 };
        }
        return [{ provider: 'pi', entries: [entry], groups: [{ label: 'synthetic', entries: [entry] }] }];
      },
    };
    findNode(
      h.render('SandboxSettings', props),
      (node) => node.type === 'details' && !!node.props.onToggle,
    )!.props.onToggle({ currentTarget: { open: true } });
    await nextTurn();
    findNode(
      h.render('SandboxSettings', props),
      (node) => node.type === 'input' && node.props.type === 'checkbox',
    )!.props.onChange({ target: { checked: true } });
    findNode(
      h.render('SandboxSettings', props),
      (node) => node.type === 'button' && text(node).includes('采用'),
    )!.props.onClick();
    await nextTurn();
    assert.deepEqual(calls, [{ provider: 'pi', ids: [entry.id] }]);
    assert.deepEqual(
      plain(notices),
      denied ? [{ tone: 'error', message: '放宽安全设置或修改执行命令需要在桌面应用中确认。' }] : [],
    );
  }
});
const state = (): AppState => ({
  app: { name: 'PugPort', version: 'synthetic', platform: 'win32', dataDir: 'synthetic' },
  targets: [
    {
      id: 'codex-native',
      provider: 'codex',
      label: 'Synthetic',
      command: 'synthetic',
      environment: 'native',
      enabled: true,
    },
  ],
  runtimes: [],
  runs: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    sandbox: { pi: 'enforce', codex: 'enforce' },
    sandboxWhenUnavailable: 'stop',
    toolApprovalMode: 'ask',
    autoUseResetCards: false,
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'codex',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'synthetic',
    maxConcurrentRuns: 1,
    automaticExecutors: ['codex-native'],
  },
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join('')
    : node && typeof node === 'object'
      ? text((node as UiNode).props?.children)
      : typeof node === 'string'
        ? node
        : '';

test('sandbox settings save immediately through native IPC without resubmitting unrelated fields', async () => {
  const calls: any[] = [];
  const h = uiHarness(code, {
    window: {
      comboRunnerDesktop: {
        pickDirectory() {},
        async changePermission(change: unknown) {
          calls.push(plain(change));
          return true;
        },
      },
    },
  });
  const props = {
    category: 'permissions',
    state: state(),
    api: async (...args: any[]) => calls.push(args),
    reload: async () => {},
    notify() {},
  };
  findNode(h.render('SettingsPage', props), (node) => node.type?.name === 'SandboxSettings')!.props.change('sandbox', {
    pi: 'learn',
  });
  await nextTurn();
  assert.deepEqual(calls, [{ kind: 'settings', patch: { sandbox: { pi: 'learn' } } }]);
  h.unmount();
});

test('App reset-card switch uses native confirmation when enabled; cancellation restores it', async () => {
  for (const allow of [false, true]) {
    const calls: any[] = [];
    const props = {
      category: 'routing',
      state: state(),
      api: async (...args: any[]) => {
        calls.push(args);
      },
      reload: async () => {},
      notify() {},
    };
    const h = uiHarness(code, {
      window: {
        comboRunnerDesktop: {
          pickDirectory() {},
          async changePermission(change: unknown) {
            calls.push(plain(change));
            return allow;
          },
        },
      },
    });
    const toggle = (tree: unknown) =>
      findNode(
        findNode(tree, (node) => node.type === 'label' && text(node).includes('额度用完时自动用重置卡')),
        (node) => node.type === 'input',
      )!;
    toggle(h.render('SettingsPage', props)).props.onChange({ target: { checked: true } });
    await nextTurn();
    assert.deepEqual(calls, [{ kind: 'settings', patch: { autoUseResetCards: true } }]);
    assert.equal(toggle(h.render('SettingsPage', props)).props.checked, allow);
  }
});

test('cancelling an immediate relaxing change sends no HTTP patch and restores the old sandbox', async () => {
  const calls: any[] = [];
  const h = uiHarness(code, {
    window: {
      comboRunnerDesktop: {
        pickDirectory() {},
        async changePermission() {
          return false;
        },
      },
    },
  });
  const props = {
    category: 'permissions',
    state: state(),
    api: async (...args: any[]) => calls.push(args),
    reload: async () => {},
    notify() {},
  };
  const sandbox = () => findNode(h.render('SettingsPage', props), (node) => node.type?.name === 'SandboxSettings')!;
  sandbox().props.change('sandbox', {});
  await nextTurn();
  assert.deepEqual(calls, []);
  assert.deepEqual(plain(sandbox().props.settings.sandbox), { pi: 'enforce', codex: 'enforce' });
  h.unmount();
});

test('unchanged executor command saves through HTTP; changing args uses native IPC first', async () => {
  for (const changed of [false, true]) {
    const calls: any[] = [];
    const snapshot = state();
    const props = {
      target: snapshot.targets[0],
      api: async (path: string, body: unknown, method: string) => {
        calls.push({ path, body: plain(body), method });
      },
      reload: async () => {},
      notify() {},
    };
    const h = uiHarness(code, {
      window: {
        comboRunnerDesktop: {
          pickDirectory() {},
          async changePermission(change: unknown) {
            calls.push(plain(change));
            return true;
          },
        },
      },
    });
    let tree = h.render('TargetEditor', props);
    if (changed) {
      const args = findNode(tree, (node) => node.type === 'textarea');
      assert.ok(args);
      args.props.onChange({ target: { value: 'synthetic-arg' } });
      tree = h.render('TargetEditor', props);
    }
    findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
    await nextTurn();
    assert.equal(calls.length, changed ? 2 : 1);
    if (changed) assert.equal(calls[0].kind, 'target-command');
    const http = calls.at(-1);
    assert.equal(http.path, '/api/targets/codex-native');
    assert.equal('command' in http.body, false);
    assert.equal('args' in http.body, false);
  }
});

test('adopting learned access uses the desktop channel instead of HTTP', async () => {
  const sandboxCode = await uiBundle('src/ui/SandboxSettings.tsx');
  const changes: any[] = [],
    calls: string[] = [];
  const entry = { id: 'a'.repeat(64), resource: 'C:/synthetic/file', resourceType: 'file', accessType: 'read' };
  const h = uiHarness(sandboxCode, {
    window: {
      comboRunnerDesktop: {
        pickDirectory() {},
        async changePermission(change: unknown) {
          changes.push(plain(change));
          return true;
        },
      },
    },
  });
  const props = {
    status: { available: true, sdkVersion: '1.0.1' },
    settings: state().settings,
    change() {},
    notify() {},
    reload: async () => {},
    api: async (path: string) => {
      calls.push(path);
      return [
        {
          provider: 'pi',
          observedAt: '2026-10-14T12:00:00Z',
          truncated: false,
          entries: [entry],
          groups: [{ label: 'C:/synthetic', read: 1, write: 0, execute: 0, entries: [entry] }],
        },
      ];
    },
  };
  let tree = h.render('SandboxSettings', props);
  findNode(tree, (node) => node.type === 'details' && !!node.props.onToggle)!.props.onToggle({
    currentTarget: { open: true },
  });
  await nextTurn();
  tree = h.render('SandboxSettings', props);
  findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({
    target: { checked: true },
  });
  tree = h.render('SandboxSettings', props);
  findNode(tree, (node) => node.type === 'button' && text(node).includes('采用'))!.props.onClick();
  await nextTurn();
  assert.deepEqual(calls, ['/api/sandbox/learning']);
  assert.deepEqual(changes, [{ kind: 'sandbox-adopt', provider: 'pi', ids: [entry.id] }]);
});

test('a failed text write keeps the draft for the small save button to retry', async () => {
  let fail = true;
  const writes: unknown[] = [];
  const h = uiHarness(code, { Error });
  const props = {
    state: state(),
    category: 'personal',
    notify() {},
    reload: async () => {},
    api: async (_path: string, body: unknown) => {
      if (fail) throw new Error('Synthetic offline');
      writes.push(plain(body));
    },
  };
  const field = () => findNode(h.render('SettingsPage', props), (node) => node.props.id === 'global-instructions')!;
  const saveButton = () =>
    findNode(h.render('SettingsPage', props), (node) => node.type === 'button' && node.props.children === '保存');
  assert.equal(saveButton(), undefined);
  field().props.onChange({ target: { value: 'Keep this draft' } });
  field().props.onBlur();
  await nextTurn();
  assert.equal(field().props.value, 'Keep this draft');
  fail = false;
  findNode(
    h.render('SettingsPage', props),
    (node) => node.type === 'button' && node.props.children === '保存',
  )!.props.onClick();
  await nextTurn();
  assert.deepEqual(writes, [{ globalInstructions: 'Keep this draft' }]);
  assert.equal(saveButton(), undefined);
  h.unmount();
});

test('sound defaults on, saves its own field and hides when notifications are never', async () => {
  const writes: unknown[] = [];
  const h = uiHarness(code);
  const props = {
    state: state(),
    category: 'general',
    notify() {},
    reload: async () => {},
    api: async (_path: string, body: unknown) => {
      writes.push(plain(body));
    },
  };
  const render = () => h.render('SettingsPage', props);
  const sound = () => findNode(render(), (node) => node.props['aria-labelledby'] === 'notify-sound-label');
  assert.equal(sound()!.props.checked, true);
  sound()!.props.onChange({ target: { checked: false } });
  await nextTurn();
  assert.deepEqual(writes, [{ notifySound: false }]);
  assert.equal(sound()!.props.checked, false);
  findNode(render(), (node) => node.props['aria-label'] === '任务完成通知')!.props.onChange({
    target: { value: 'never' },
  });
  await nextTurn();
  assert.equal(sound(), undefined);
  h.unmount();
});

test('advanced text fields save valid individual values on blur and accept POSIX paths', async () => {
  const writes: any[] = [],
    notices: any[] = [];
  const h = uiHarness(code, { Error });
  const props = {
    state: state(),
    category: 'advanced',
    notify: (notice: unknown) => notices.push(notice),
    reload: async () => {},
    api: async (_path: string, body: unknown) => writes.push(plain(body)),
  };
  const field = (key: string) =>
    findNode(
      h.render('SettingsPage', props),
      (node) => node.type === 'input' && String(node.props.onChange).includes(key),
    )!;
  field('refreshSeconds').props.onChange({ target: { valueAsNumber: 29 } });
  field('refreshSeconds').props.onBlur();
  await nextTurn();
  assert.deepEqual(writes, []);
  assert.match(notices.at(-1).message, /请输入范围内的整数/);
  field('refreshSeconds').props.onChange({ target: { valueAsNumber: 90 } });
  field('refreshSeconds').props.onBlur();
  await nextTurn();
  field('defaultProjectPath').props.onChange({ target: { value: '/synthetic/project' } });
  field('defaultProjectPath').props.onBlur();
  await nextTurn();
  assert.deepEqual(writes, [{ refreshSeconds: 90 }, { defaultProjectPath: '/synthetic/project' }]);
  h.unmount();
});

for (const first of ['text blur', 'another switch']) {
  test(`a queued switch stays checked while ${first} reloads settings`, async () => {
    const h = uiHarness(code);
    const server = state();
    server.settings.steerOnSend = false;
    server.settings.showAutomaticReplyIdentity = false;
    const writes: unknown[] = [];
    const releases: (() => void)[] = [];
    const props = {
      state: structuredClone(server),
      category: first === 'text blur' ? 'personal' : 'conversation',
      notify() {},
      api: async (_path: string, patch: object) => {
        writes.push(plain(patch));
        await new Promise<void>((resolve) => releases.push(resolve));
        Object.assign(server.settings, patch);
      },
      reload: async () => {
        props.state = structuredClone(server);
        h.render('SettingsPage', props);
      },
    };
    const render = () => h.render('SettingsPage', props);
    const field = (label: string) => findNode(render(), (node) => node.props['aria-label'] === label)!;
    if (first === 'text blur') {
      const input = findNode(render(), (node) => node.props.id === 'global-instructions')!;
      input.props.onChange({ target: { value: 'Synthetic instructions' } });
      input.props.onBlur();
      findNode(render(), (node) => node.type?.name === 'MemoryDistillationSwitch')!.props.onChange({ enabled: true });
    } else {
      field('自动插话').props.onChange({ target: { checked: true } });
      field('显示自动回复的执行器、模型和强度').props.onChange({ target: { checked: true } });
    }
    const queuedValue = () =>
      first === 'text blur'
        ? findNode(render(), (node) => node.type?.name === 'MemoryDistillationSwitch')!.props.settings
            .memoryDistillation?.enabled === true
        : field('显示自动回复的执行器、模型和强度').props.checked;
    assert.equal(queuedValue(), true);
    await nextTurn();
    assert.equal(writes.length, 1);
    releases.shift()!();
    await nextTurn();
    assert.equal(writes.length, 2);
    assert.equal(queuedValue(), true, 'the first reload must preserve the queued switch');
    releases.shift()!();
    await nextTurn();
    assert.equal(queuedValue(), true);
    // Finished keys must follow later server updates again.
    props.state = state();
    props.state.settings.showAutomaticReplyIdentity = false;
    props.state.settings.memoryDistillation = { enabled: false };
    assert.equal(queuedValue(), false);
    h.unmount();
  });
}
