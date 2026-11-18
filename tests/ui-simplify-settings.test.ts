import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('sandbox master preserves other providers and per-executor edits stay independent', async () => {
  const h = uiHarness(await uiBundle('src/ui/SandboxSettings.tsx'));
  const changes: unknown[] = [];
  const props = {
    status: { available: true, sdkVersion: '1.0.1' },
    settings: { sandbox: { pi: 'learn', claude: 'off', codex: 'enforce', gemini: 'off' } },
    change: (key: string, value: unknown) => changes.push(JSON.parse(JSON.stringify({ key, value }))),
    api: async () => [],
    reload: async () => {},
    notify() {},
  };
  const render = () => h.render('SandboxSettings', props);
  const master = () => findNode(render(), (node) => node.props['aria-label'] === '学习模式')!;
  assert.equal(master().props.value, 'custom');
  assert.deepEqual(changes, []);
  master().props.onChange({ target: { value: 'learn' } });
  assert.deepEqual(changes.pop(), {
    key: 'sandbox',
    value: {
      pi: 'learn',
      claude: 'learn',
      grok: 'learn',
      cursor: 'learn',
      codex: 'enforce',
      gemini: 'off',
    },
  });
  master().props.onChange({ target: { value: 'off' } });
  assert.deepEqual(changes.pop(), {
    key: 'sandbox',
    value: {
      pi: 'off',
      claude: 'off',
      grok: 'off',
      cursor: 'off',
      codex: 'enforce',
      gemini: 'off',
    },
  });
  const details = findNode(render(), (node) => node.type === 'details' && text(node).startsWith('按执行器设置'))!;
  assert.equal(details.props.open, undefined);
  findNode(details, (node) => node.props['aria-label'] === 'Claude')!.props.onChange({ target: { value: 'learn' } });
  assert.deepEqual(changes.pop(), {
    key: 'sandbox',
    value: {
      pi: 'learn',
      claude: 'learn',
      codex: 'enforce',
      gemini: 'off',
    },
  });
  h.unmount();
});

test('work folder picker saves only a selected path, retains typed entry, and handles cancellation and error', async () => {
  let selection: string | null | Error = null;
  const writes: unknown[] = [],
    notices: unknown[] = [];
  const h = uiHarness(await uiBundle('src/ui/App.tsx'), {
    Error,
    window: {
      comboRunnerDesktop: {
        pickDirectory: async () => {
          if (selection instanceof Error) throw selection;
          return selection;
        },
      },
    },
  });
  const props = {
    category: 'advanced',
    state: {
      app: { platform: 'win32' },
      settings: { defaultProjectPath: 'C:/Synthetic', maxConcurrentRuns: 0 },
      targets: [],
      runtimes: [],
    },
    api: async (path: string, body: unknown, method: string) =>
      writes.push(JSON.parse(JSON.stringify({ path, body, method }))),
    reload: async () => {},
    notify: (notice: unknown) => notices.push(notice),
  };
  const render = () => h.render('SettingsPage', props);
  const picker = () => findNode(render(), (node) => node.type === 'button' && text(node) === '选择文件夹')!;
  const input = () => findNode(render(), (node) => node.props['aria-label'] === '默认工作文件夹')!;
  await picker().props.onClick();
  assert.deepEqual(writes, []);
  selection = 'C:/Synthetic/Selected';
  await picker().props.onClick();
  assert.equal(input().props.value, selection);
  assert.deepEqual(writes.pop(), { path: '/api/settings', body: { defaultProjectPath: selection }, method: 'PATCH' });
  input().props.onChange({ target: { value: 'C:/Synthetic/Typed' } });
  input().props.onBlur();
  await nextTurn();
  assert.deepEqual(writes.pop(), {
    path: '/api/settings',
    body: { defaultProjectPath: 'C:/Synthetic/Typed' },
    method: 'PATCH',
  });
  selection = new Error('Synthetic picker failure');
  await picker().props.onClick();
  assert.equal(input().props.value, 'C:/Synthetic/Typed');
  assert.equal(picker().props.disabled, false);
  assert.equal((notices.at(-1) as any).tone, 'error');
  assert.deepEqual(writes, []);
  const concurrency = findNode(render(), (node) => node.type === 'details' && text(node).startsWith('任务并发：自动'))!;
  assert.equal(concurrency.props.open, undefined);
  findNode(concurrency, (node) => node.type === 'select')!.props.onChange({ target: { value: '3' } });
  await nextTurn();
  assert.deepEqual(writes.pop(), { path: '/api/settings', body: { maxConcurrentRuns: 3 }, method: 'PATCH' });
  assert.ok(findNode(render(), (node) => node.type === 'summary' && text(node) === '任务并发：自定义'));
  h.unmount();
});
