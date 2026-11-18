import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HindsightSettingsPanel } from '../src/ui/HindsightSettings.tsx';
import { defaultHindsightSettings } from '../src/shared/hindsight.ts';
import type { AppState } from '../src/shared/types.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const budget = {
  perRunUsd: 0.1,
  limitUsd: 2,
  maxConcurrentRuns: 1,
  burstConcurrentRuns: 1,
  preferExpiring: true,
  startedAt: '2026-10-22T00:00:00Z',
};
const state = {
  targets: [
    {
      id: 'managed-api',
      label: 'Synthetic API',
      gateway: 'api',
      apiProvider: 'custom',
      enabled: true,
      apiBudget: budget,
    },
    { id: 'native-cli', label: 'Native CLI', enabled: true },
    { id: 'direct-pi', label: 'Ambient Pi', enabled: true },
    {
      id: 'disabled-api',
      label: 'Disabled API',
      gateway: 'api',
      apiProvider: 'custom',
      enabled: true,
      executionDisabledByUser: true,
      apiBudget: budget,
    },
    { id: 'unbudgeted-api', label: 'No budget', gateway: 'api', apiProvider: 'custom', enabled: true },
  ],
  projects: [{ id: 'project-id', name: 'Synthetic project' }],
  apiProviders: [{ targetId: 'managed-api', budget: { policy: budget, phase: 'normal', remainingUsd: 1.23 } }],
} as unknown as AppState;
const configured = {
  ...defaultHindsightSettings,
  pythonExecutable: 'C:/Synthetic/python.exe',
  runtimeId: 'managed-api',
  projectIds: ['project-id'],
};
const code = await uiBundle('src/ui/HindsightSettings.tsx');

test('Hindsight starts off, keeps details collapsed and excludes CLI, ambient and unbudgeted executors', () => {
  const html = renderToStaticMarkup(
    createElement(HindsightSettingsPanel, {
      state,
      api: async <T>() => ({ state: 'disabled' }) as T,
      onChange() {},
    }),
  );
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /class="settings-row-details" hidden/);
  assert.match(html, /默认关闭/);
  assert.match(html, /Hindsight 1.1.0/);
  assert.match(html, /继续使用本地记忆/);
  assert.doesNotMatch(html, /checked=""|type="password"/);
  assert.match(html, /Synthetic API/);
  assert.doesNotMatch(html, /Native CLI|Ambient Pi|Disabled API|No budget/);
});

test('saving preserves stable project IDs and enablement waits for saved complete configuration', async () => {
  const writes: unknown[] = [];
  const paths: unknown[] = [];
  const props = {
    state,
    settings: undefined as typeof configured | undefined,
    api: async (...args: unknown[]) => {
      paths.push(args);
      return { state: 'disabled' };
    },
    onChange(value: typeof configured) {
      writes.push(value);
      props.settings = value;
    },
  };
  const h = uiHarness(code);
  const render = () => h.render('HindsightSettingsPanel', props);
  const input = (label: string) => findNode(render(), (node) => node.props['aria-label'] === label)!;
  const save = () => findNode(render(), (node) => node.type === 'button' && node.props.children === '保存配置')!;
  assert.equal(input('启用 Hindsight 项目记忆').props.disabled, true);
  input('Hindsight Python 可执行文件').props.onChange({ target: { value: configured.pythonExecutable } });
  input('Hindsight API 账号').props.onChange({ target: { value: 'managed-api' } });
  input('Synthetic project').props.onChange({ target: { checked: true } });
  assert.equal(input('启用 Hindsight 项目记忆').props.disabled, true, 'unsaved draft must not enable memory');
  save().props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), configured);
  assert.equal(input('启用 Hindsight 项目记忆').props.disabled, false);
  input('启用 Hindsight 项目记忆').props.onChange({ target: { checked: true } });
  assert.equal((writes[1] as typeof configured).enabled, true);
  await nextTurn();
  assert.ok(
    paths.every((args) => JSON.stringify(args) === JSON.stringify(['/api/hindsight/status', undefined, 'GET'])),
  );
  h.unmount();
});

test('out-of-range caps cannot be saved and unknown project selections need explicit removal', () => {
  const h = uiHarness(code);
  const props = {
    state,
    settings: { ...configured, enabled: true, projectIds: ['project-id', 'missing-id'] },
    api: async () => ({ state: 'ready' }),
    onChange() {},
  };
  const render = () => h.render('HindsightSettingsPanel', props);
  const field = findNode(render(), (node) => node.props['aria-label'] === 'Hindsight 每日模型调用上限')!;
  field.props.onChange({ target: { value: '101' } });
  assert.ok(findNode(render(), (node) => node.props.role === 'alert'));
  assert.equal(
    findNode(render(), (node) => node.type === 'button' && node.props.children === '保存配置')!.props.disabled,
    true,
  );
  assert.ok(findNode(render(), (node) => node.type === 'button' && node.props.children === '清除不可用项目'));
  assert.equal(
    findNode(render(), (node) => node.props['aria-label'] === '启用 Hindsight 项目记忆')!.props.disabled,
    false,
    'turning off is always available',
  );
  h.unmount();
});

test('expired API and failed status reads explain local memory fallback without a model test', async () => {
  const h = uiHarness(code);
  const props = {
    state: { ...state, apiProviders: [{ targetId: 'managed-api', budget: { phase: 'expired' } }] },
    settings: { ...configured, enabled: true },
    api: async () => {
      throw new Error('Synthetic offline');
    },
    onChange() {},
  };
  h.render('HindsightSettingsPanel', props);
  await nextTurn();
  const tree = h.render('HindsightSettingsPanel', props);
  assert.ok(findNode(tree, (node) => node.props.children === '无法读取服务状态；继续使用本地记忆。'));
  assert.ok(
    findNode(
      tree,
      (node) => Array.isArray(node.props.children) && node.props.children.includes('所选 API 已过期，记忆服务暂停。'),
    ),
  );
  h.unmount();
});

test('forget sends one explicit project action and distinguishes local revocation from service deletion', async () => {
  for (const serviceDeleted of [false, true]) {
    const calls: unknown[][] = [];
    let release!: (value: unknown) => void;
    const props = {
      state,
      api: async (...args: unknown[]) => {
        if (args[0] === '/api/hindsight/status') return { state: 'disabled' };
        calls.push(args);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      onChange() {
        assert.fail('Forget must not rewrite settings or chats');
      },
    };
    const h = uiHarness(code);
    const render = () => h.render('HindsightSettingsPanel', props);
    const button = () =>
      findNode(render(), (node) => node.type === 'button' && node.props.children === '清除此项目的 Hindsight 副本')!;
    assert.equal(button().props.disabled, true);
    findNode(render(), (node) => node.props['aria-label'] === '要清除 Hindsight 副本的项目')!.props.onChange({
      target: { value: 'project-id' },
    });
    const click = button().props.onClick;
    click();
    click();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), [
      '/api/hindsight/forget',
      { projectId: 'project-id' },
      'POST',
    ]);
    release({ revoked: true, serviceDeleted });
    await nextTurn();
    const notice = findNode(
      render(),
      (node) =>
        node.props.role === 'status' &&
        typeof node.props.children === 'string' &&
        node.props.children.includes('原始对话保留'),
    )!;
    assert.ok(notice);
    assert.equal(notice.props.children.includes('尚未确认'), !serviceDeleted);
    h.unmount();
  }
});

test('a failed forget request never claims revocation succeeded', async () => {
  const h = uiHarness(code);
  const props = {
    state,
    api: async (path: string) => {
      if (path.endsWith('/forget')) throw new Error('Synthetic offline');
      return { state: 'disabled' };
    },
    onChange() {},
  };
  const render = () => h.render('HindsightSettingsPanel', props);
  findNode(render(), (node) => node.props['aria-label'] === '要清除 Hindsight 副本的项目')!.props.onChange({
    target: { value: 'project-id' },
  });
  findNode(
    render(),
    (node) => node.type === 'button' && node.props.children === '清除此项目的 Hindsight 副本',
  )!.props.onClick();
  await nextTurn();
  assert.ok(
    findNode(
      render(),
      (node) => node.props.role === 'status' && String(node.props.children).startsWith('无法确认清除结果'),
    ),
  );
  h.unmount();
});
