import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, RunRecord, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { HandoffModal, RunOutput, SettingsPage, TargetEditor } from '../src/ui/App.tsx';
import {
  ProjectDialog,
  WorkspaceExecutionFields,
  workspaceExecutionSelection,
  workspaceRouteFields,
} from '../src/ui/Workspace.tsx';
import { desktopBridge } from '../src/ui/desktop.ts';
import { availableCoreTargets, runtimeIdentity, unavailableRuntimeLabel } from '../src/ui/core-runtime.ts';

const targets: RuntimeTarget[] = [
  {
    id: 'codex-native',
    label: 'Codex Native',
    provider: 'codex',
    environment: 'native',
    command: 'fixture',
    enabled: true,
  },
  { id: 'pi-local', label: 'Pi', provider: 'pi', environment: 'native', command: 'fixture', enabled: true },
  {
    id: 'dsh-local',
    label: 'Legacy DSH Label',
    provider: 'dsh',
    environment: 'native',
    command: 'fixture',
    enabled: true,
  },
];
const run: RunRecord = {
  id: 'legacy-run',
  prompt: 'Historical task',
  projectPath: 'C:/Fixture',
  kind: 'general',
  status: 'completed',
  route: { runtimeId: 'dsh-local', model: 'historical-model', kind: 'general', reasons: [], warnings: [] },
  startedAt: '2026-09-26T10:00:00Z',
  output: 'Historical output',
  events: [],
};
const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets,
  runtimes: [],
  runs: [run],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'dsh',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 1,
  },
};
const actions = { api: async <T>() => ({}) as T, notify() {}, reload: async () => {} };

test('automatic reset-card setting defaults off and renders the persisted value and both triggers', () => {
  for (const autoUseResetCards of [undefined, false, true]) {
    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        category: 'routing',
        ...actions,
        state: { ...state, settings: { ...state.settings, autoUseResetCards } },
      }),
    );
    const label = html
      .match(/<label class="setting-row">[\s\S]*?<\/label>/g)
      ?.find((value) => value.includes('额度用完时自动用重置卡'));
    const control = label?.match(/<input[^>]*\/>/);
    assert.ok(control, 'the setting has a labelled checkbox');
    assert.match(control[0], /type="checkbox"/);
    assert.equal(control[0].includes('checked=""'), autoUseResetCards === true);
    assert.match(html, /默认关闭。开启后，有任务等待且额度耗尽时用一张/);
    assert.match(html, /卡片到期前 10\s*分钟内，只要额度用过就用掉它/);
    assert.match(html, /不改变路由排序/);
  }
});

test('tool confirmation has its own setting and Pi is not presented as a subscription account', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'permissions',
      ...actions,
      state: { ...state, settings: { ...state.settings, decisionMode: 'confirm', toolApprovalMode: 'auto' } },
    }),
  );
  assert.match(html, /aria-label="工具确认方式"/);
  assert.match(html, /value="auto" selected="">自动执行 · 默认/);
  const routing = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'routing',
      ...actions,
      state: { ...state, settings: { ...state.settings, decisionMode: 'confirm' } },
    }),
  );
  assert.match(routing, /value="confirm" selected="">先给建议，确认后运行/);
  const pi = renderToStaticMarkup(createElement(TargetEditor, { ...actions, target: targets[1] }));
  assert.match(pi, /只记录模型调用的实际消耗/);
  assert.doesNotMatch(pi, /用量统计方式|订阅额度 \+ 调用消耗/);
});

test('new core tasks exclude DSH even in stale enabled targets while history retains its label', () => {
  assert.deepEqual(
    availableCoreTargets(targets).map((target) => target.id),
    ['codex-native', 'pi-local'],
  );
  assert.deepEqual(
    availableCoreTargets(targets, 'cli-only').map((target) => target.id),
    ['codex-native'],
  );
  assert.deepEqual(
    availableCoreTargets(targets, 'api-only').map((target) => target.id),
    ['pi-local'],
  );
  assert.equal(runtimeIdentity(state, 'dsh-local')?.label, 'Legacy DSH Label');
  assert.equal(unavailableRuntimeLabel(state, 'dsh-local'), 'Legacy DSH Label · 不可用');
  const composer = renderToStaticMarkup(
    createElement(WorkspaceExecutionFields, {
      state: state,
      policy: 'cli-first',
      selection: '',
      model: '',
      onSelection() {},
      onModel() {},
    }),
  );
  assert.doesNotMatch(composer, /value="dsh-local"/);
});

test('fixed preferences are advanced and opt-in while disconnected saved values remain visible', () => {
  const automatic = renderToStaticMarkup(createElement(SettingsPage, { category: 'routing', ...actions, state }));
  assert.doesNotMatch(automatic, /按任务分类路由/);
  const disabled = renderToStaticMarkup(createElement(SettingsPage, { category: 'advanced', ...actions, state }));
  assert.match(disabled, /启用固定路由偏好/);
  assert.match(disabled, /显示其他 Agent 派来的对话/);
  assert.match(disabled, /侧栏不列出这些对话/);
  assert.match(disabled, /<input type="checkbox"(?![^>]*\schecked)[^>]*aria-label="显示其他 Agent 派来的对话"/);
  assert.doesNotMatch(automatic, /显示其他 Agent 派来的对话/);
  assert.doesNotMatch(disabled, /按任务分类路由/);
  const html = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'advanced',
      ...actions,
      state: { ...state, settings: { ...state.settings, routePreferencesEnabled: true, showAgentConversations: true } },
    }),
  );
  assert.match(html, /按任务分类路由/);
  assert.match(html, /aria-label="显示其他 Agent 派来的对话"[^>]*checked=""/);
  assert.match(html, /部分已保存的平台偏好不可用/);
  assert.match(html, /dsh · 不可用/i);
});

test('retired target cannot show config or connection-test actions, and handoff excludes it', () => {
  const html = renderToStaticMarkup(createElement(TargetEditor, { ...actions, target: targets[2] }));
  assert.match(html, /已移出核心，不可用/);
  assert.doesNotMatch(html, /<button|<input|<select/);
  const handoff = renderToStaticMarkup(
    createElement(HandoffModal, { ...actions, run, state, onClose() {}, onRun() {} }),
  );
  assert.doesNotMatch(handoff, /value="dsh-local"/);
});

test('old execution output preserves the retired target name without an active snapshot', () => {
  const html = renderToStaticMarkup(
    // Historical native output belongs to the trace; the Output tab only shows a persisted PugPort final reply.
    createElement(RunOutput, { ...actions, run, runtimes: [], targets, initialTab: 'trajectory', onHandoff() {} }),
  );
  assert.match(html, /Legacy DSH Label/);
  assert.match(html, /Historical output/);
  assert.match(html, /historical-model/);
});

const wslTarget: RuntimeTarget = {
  id: 'codex-wsl',
  label: 'Historical Codex WSL',
  provider: 'codex',
  environment: 'wsl',
  command: 'fixture',
  enabled: true,
};
const customWslTarget: RuntimeTarget = { ...wslTarget, id: 'custom-wsl', label: 'Custom WSL' };
const readyRuntime = (target: RuntimeTarget): RuntimeSnapshot => ({
  id: target.id,
  label: target.label,
  provider: target.provider,
  environment: target.environment,
  installed: true,
  status: 'ready',
  models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low'] }],
  quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: '2026-09-27T12:00:00Z',
});
const wslRun: RunRecord = {
  ...run,
  id: 'old-wsl-run',
  route: { ...run.route, runtimeId: wslTarget.id },
  nativeSessionId: 'old-wsl-session',
  output: 'Preserved WSL result',
};
const wslState: AppState = {
  ...state,
  targets: [...targets, wslTarget, customWslTarget],
  runtimes: [readyRuntime(targets[0]), readyRuntime(wslTarget), readyRuntime(customWslTarget)],
  runs: [wslRun],
};

test('enabled WSL targets are excluded from new execution choices while their historical identity remains available', () => {
  assert.deepEqual(
    availableCoreTargets(wslState.targets).map((target) => target.id),
    ['codex-native', 'pi-local'],
  );
  assert.deepEqual(
    availableCoreTargets(wslState.targets, 'cli-only').map((target) => target.id),
    ['codex-native'],
  );
  assert.deepEqual(
    availableCoreTargets(wslState.targets, 'api-only').map((target) => target.id),
    ['pi-local'],
  );
  assert.deepEqual(
    availableCoreTargets([...targets, { ...wslTarget, environment: 'native' }]).map((target) => target.id),
    ['codex-native', 'pi-local'],
    'the retired built-in ID must not become executable through a stale environment field',
  );
  assert.equal(runtimeIdentity(wslState, wslTarget.id)?.label, wslTarget.label);
  assert.equal(unavailableRuntimeLabel(wslState, wslTarget.id), `${wslTarget.label} · 不可用`);
  const html = renderToStaticMarkup(
    createElement(WorkspaceExecutionFields, {
      state: wslState,
      policy: 'cli-first',
      selection: '',
      model: '',
      onSelection() {},
      onModel() {},
    }),
  );
  assert.match(html, /value="codex-native"/);
  assert.doesNotMatch(html, /value="(?:codex-wsl|custom-wsl)"/);
});

test('a saved fixed WSL selection stays selected and unavailable rather than becoming automatic dispatch', () => {
  for (const target of [wslTarget, customWslTarget]) {
    const selected = workspaceExecutionSelection(wslState, 'cli-first', target.id);
    assert.equal(selected.unavailable, true);
    assert.deepEqual(workspaceRouteFields(target.id), { runtimeId: target.id });
    const html = renderToStaticMarkup(
      createElement(WorkspaceExecutionFields, {
        state: wslState,
        policy: 'cli-first',
        selection: target.id,
        model: 'fixture-model',
        onSelection() {},
        onModel() {},
      }),
    );
    assert.ok(html.includes(`value="${target.id}" disabled="" selected="">${target.label} · 不可用`));
    assert.doesNotMatch(html, /value="" selected="">自动调度/);
    assert.match(html, /aria-label="任务模型" disabled=""/);
  }
});

test('WSL targets expose no configuration or test controls and cannot be handoff destinations', () => {
  for (const target of [wslTarget, customWslTarget, { ...wslTarget, environment: 'native' as const }]) {
    const html = renderToStaticMarkup(
      createElement(TargetEditor, { ...actions, target, snapshot: readyRuntime(target) }),
    );
    assert.ok(html.includes(target.label));
    assert.doesNotMatch(html, /<form|<button|<input|<select/);
  }
  const handoff = renderToStaticMarkup(
    createElement(HandoffModal, { ...actions, run: wslRun, state: wslState, onClose() {}, onRun() {} }),
  );
  assert.match(handoff, /value="codex-native"/);
  assert.doesNotMatch(handoff, /value="(?:codex-wsl|custom-wsl)"/);
});

test('settings no longer offer WSL routing preferences but old WSL output remains readable', () => {
  const settings = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'routing',
      ...actions,
      state: { ...wslState, settings: { ...wslState.settings, preferNative: false } },
    }),
  );
  assert.doesNotMatch(settings, /本机与 WSL|WSL 保留为备用环境|同一平台优先使用本机 CLI/);
  const html = renderToStaticMarkup(
    createElement(RunOutput, {
      ...actions,
      run: wslRun,
      runtimes: [],
      targets: wslState.targets,
      initialTab: 'trajectory',
      onHandoff() {},
    }),
  );
  assert.match(html, /Historical Codex WSL/);
  assert.match(html, /Preserved WSL result/);
  assert.match(html, /historical-model/);
});

test('project dialog keeps manual input in Web and exposes the optional desktop picker only when supported', () => {
  const props = { ...actions, defaultPath: 'C:/Existing project', onClose() {}, onCreated() {} };
  assert.equal(desktopBridge(), undefined);
  const web = renderToStaticMarkup(createElement(ProjectDialog, props));
  assert.match(web, /value="C:\/Existing project"/);
  assert.doesNotMatch(web, /选择项目文件夹/);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { comboRunnerDesktop: { pickDirectory: async () => null } },
    });
    const desktop = renderToStaticMarkup(createElement(ProjectDialog, props));
    assert.match(desktop, /aria-label="选择项目文件夹"/);
    assert.match(desktop, /value="C:\/Existing project"/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('advanced routing offers Jev without restoring retired credentials or their saved source', () => {
  for (const source of [undefined, 'C:/Users/fixture/.jev-router.env', 'environment:JEV_API_KEY']) {
    const legacy = {
      ...state,
      settings: { ...state.settings, taskJudgment: 'jev', decisionMode: 'auto' },
      jev: { configured: !!source, status: source ? 'configured-unverified' : 'not-configured', source },
    } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(SettingsPage, { category: 'advanced', ...actions, state: legacy }));
    assert.match(html, /<option value="jev">Jev<\/option>/);
    assert.doesNotMatch(html, /JEV_API_KEY|jev-router|settings-judgment|type="password"/);
  }
});
