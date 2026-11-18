import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultSandboxModes } from '../src/shared/sandbox.ts';
import { sandboxSettingsSchema } from '../src/server/sandbox/settings.ts';
import { SettingsPage } from '../src/ui/App.tsx';
import { SandboxSettings } from '../src/ui/SandboxSettings.tsx';
import type { AppState } from '../src/shared/types.ts';

test('sandbox defaults are off and settings validate provider keys, modes and unavailable policy', () => {
  assert.deepEqual(defaultSandboxModes(), {
    codex: 'off',
    claude: 'off',
    grok: 'off',
    cursor: 'off',
    gemini: 'off',
    pi: 'off',
  });
  assert.ok(sandboxSettingsSchema.safeParse({ sandbox: { gemini: 'learn' } }).success);
  assert.deepEqual(sandboxSettingsSchema.parse({ sandbox: { codex: 'learn' }, sandboxWhenUnavailable: 'stop' }), {
    sandbox: { codex: 'learn' },
    sandboxWhenUnavailable: 'stop',
  });
  assert.ok(
    sandboxSettingsSchema.safeParse({ sandbox: { pi: 'enforce' }, sandboxWhenUnavailable: 'run-as-today' }).success,
  );
  for (const input of [
    { sandbox: { dsh: 'off' } },
    { sandbox: { codex: 'on' } },
    { sandbox: [] },
    { sandbox: null },
    { sandboxWhenUnavailable: 'continue' },
  ])
    assert.equal(sandboxSettingsSchema.safeParse(input).success, false);
});

test('learning failure notes are provider-specific and explain automatic disabling', () => {
  const html = renderToStaticMarkup(
    createElement(SandboxSettings, {
      status: {
        available: true,
        reason: 'ready',
        message: '可用',
        sdkVersion: '1.0.1',
        captureDenialsStreamingSupported: true,
        learningFailures: {
          pi: { consecutiveFailures: 3, autoDisabled: true, reason: '沙箱启动失败', code: '0x80070005' },
          claude: { consecutiveFailures: 1, autoDisabled: false, reason: '沙箱启动失败' },
        },
      },
      settings: { sandbox: { pi: 'off', claude: 'learn' } } as AppState['settings'],
      change() {},
      api: async <T>() => ({}) as T,
      reload: async () => {},
      notify() {},
    }),
  );
  assert.match(html, /沙箱学习暂不可用：沙箱启动失败（0x80070005）/);
  assert.equal((html.match(/连续 3 次启动失败，已自动关闭/g) ?? []).length, 1);
  assert.match(html, /aria-describedby="sandbox-hint sandbox-failure-pi"/);
  assert.match(html, /aria-describedby="sandbox-hint sandbox-failure-claude"/);
  assert.doesNotMatch(html, /sandbox-failure-grok|sandbox-failure-cursor/);
  assert.equal((html.match(/<select[^>]*disabled=""/g) ?? []).length, 0);
});

test('settings page collapses unavailable sandbox controls and expands them when ready', () => {
  const state: AppState = {
    app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
    targets: [],
    runtimes: [],
    runs: [],
    approvals: [],
    plugins: [],
    refreshing: false,
    sandboxStatus: {
      available: false,
      reason: 'build',
      message: '不可用：系统 26300.9457，需要 26300.9550（KB5124010）',
    },
    settings: {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 120,
      preferCli: true,
      designProvider: 'claude',
      architectureProvider: 'codex',
      routineProvider: 'codex',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: 'fixture',
      maxConcurrentRuns: 1,
    },
  };
  const html = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'permissions',
      state,
      api: async <T>() => ({}) as T,
      reload: async () => {},
      notify() {},
    }),
  );
  const section = html.match(/<section id="settings-sandbox"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  assert.ok(section.includes(state.sandboxStatus!.message));
  assert.doesNotMatch(section, /<select/);
  assert.doesNotMatch(section, /Gemini/);
  assert.match(section, /<details/);
  assert.doesNotMatch(section, /<details[^>]* open/);
  assert.doesNotMatch(section, /value="enforce"/);
  assert.match(section, /重新检测/);
  state.sandboxStatus = {
    available: true,
    reason: 'ready',
    message: '可用 · 进程容器',
    sdkVersion: '1.0.1',
    captureDenialsStreamingSupported: true,
  };
  const available = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'permissions',
      state,
      api: async <T>() => ({}) as T,
      reload: async () => {},
      notify() {},
    }),
  ).match(/<section id="settings-sandbox"[\s\S]*?<\/section>/)![0];
  assert.match(available, /可用 · 进程容器/);
  assert.ok(!available.includes('disabled=""'));
  assert.doesNotMatch(available, /后续阶段开放/);
  assert.match(available, /id="sandbox-hint"/);
  assert.match(available, /查看学习记录/);
  assert.deepEqual(
    [...available.matchAll(/<select aria-label="([^"]+)"/g)].map((m) => m[1]),
    ['学习模式', 'Pi', 'Claude', 'Grok', 'Cursor'],
  );
});

test('SDK 1.0.0 disables sandbox learning selectors while preserving learning preference', () => {
  const learningUnavailableReason = '学习模式暂不可用：当前 MXC SDK（1.0.0）在记录拒绝时会崩溃，SDK 修复后自动恢复';
  const html = renderToStaticMarkup(
    createElement(SandboxSettings, {
      status: {
        available: true,
        reason: 'ready',
        message: '可用 · 进程容器',
        sdkVersion: '1.0.0',
        captureDenialsStreamingSupported: false,
        learningUnavailableReason,
      },
      settings: { sandbox: { pi: 'learn', claude: 'learn', grok: 'learn', cursor: 'learn' } } as AppState['settings'],
      change() {},
      api: async <T>() => ({}) as T,
      reload: async () => {},
      notify() {},
    }),
  );
  assert.ok(html.includes(learningUnavailableReason));
  assert.match(html, /可用 · 进程容器/);
  assert.equal((html.match(/<select[^>]*disabled=""/g) ?? []).length, 5);
  assert.equal((html.match(/value="learn" selected=""/g) ?? []).length, 5);
  assert.doesNotMatch(html, /连续 3 次启动失败，已自动关闭/);
});
