import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountSettings, AccountWelcome, AccountSyncPill } from '../src/ui/AccountSettings.tsx';
import type { AccountView } from '../src/shared/account-ui.ts';
import type { AppState } from '../src/shared/types.ts';

const base: AccountView = {
  configured: true,
  auth: { phase: 'signed-out' },
  sync: 'off',
  setup: 'none',
  devices: [],
  missingProviders: [],
};
const signed: AccountView = { ...base, auth: { phase: 'signed-in', email: 'person@example.test' }, setup: 'ready' };
const state = { targets: [], runtimes: [], settings: {}, app: { platform: 'win32' } } as unknown as AppState;
const noop = () => {};
const noCall = async (): Promise<never> => {
  throw Error('Rendering must not perform a request');
};
const render = (view: AccountView) =>
  renderToStaticMarkup(
    createElement(AccountSettings, {
      view,
      action: noCall,
      busy: false,
      state,
      api: noCall,
      reload: noCall,
      notify: noop,
      onOpenAccounts: noop,
    }),
  );

test('Account settings renders auth states and disappears without configuration', () => {
  assert.equal(render({ ...base, configured: false }), '');
  assert.match(render(base), /使用 Google 继续/);
  assert.match(render({ ...base, auth: { phase: 'signing-in' } }), /等待浏览器完成登录/);
  assert.match(
    render({ ...base, auth: { phase: 'signed-out', error: 'SESSION_EXPIRED', memoryOnly: true } }),
    /重新登录/,
  );
  const html = render({
    ...signed,
    deviceName: 'Synthetic laptop',
    lastSyncedAt: '2026-10-29T12:00:00Z',
    devices: [{ id: 'd', name: 'Other laptop', platform: 'linux', cli_providers: ['codex'] }],
  });
  for (const text of ['person@example.test', 'Synthetic laptop', 'Other laptop', '退出登录', '删除云端数据'])
    assert.ok(html.includes(text));
});

test('Waiting and merge surfaces preserve explicit gates and show both sets of counts', () => {
  const waiting = render({ ...signed, setup: 'waiting-upgrade' });
  assert.match(waiting, /<h3>等待另一台电脑<\/h3>/);
  assert.match(waiting, /在上次同步过的电脑上打开 PugPort，它会自动升级/);
  assert.match(waiting, /account-sync-state wait">.*?等待另一台电脑<\/span>/s);
  // The escape hatch stays folded away behind <details>.
  assert.match(
    waiting,
    /<details><summary>那台电脑用不了了？<\/summary><p>删除云端数据并从这台电脑重新开始。本地数据保留。<\/p><button[^>]*>删除云端数据<\/button><\/details>/,
  );
  const upgrading = render({ ...signed, setup: 'upgrading' });
  assert.match(upgrading, /正在升级云端数据…/);
  assert.doesNotMatch(upgrading, /<details>/);
  assert.match(render({ ...signed, error: 'UPGRADE_FAILED' }), /云端数据升级没有完成，会自动重试。/);
  for (const html of [waiting, upgrading]) assert.doesNotMatch(html, /恢复码|recovery/i);
  const merge = render({
    ...signed,
    setup: 'merge',
    merge: {
      local: { chats: 11, folders: 12, projects: 13, memories: 14 },
      cloud: { chats: 21, folders: 22, projects: 23, memories: 24 },
      accountChange: true,
    },
  });
  for (const n of [11, 12, 13, 14, 21, 22, 23, 24]) assert.ok(merge.includes(`<td>${n}</td>`));
  assert.match(merge, /备份本地数据/);
  assert.match(merge, /另一个账号/);
});

test('Welcome dismisses after sign-in or Skip and status stays quiet when idle', () => {
  const welcome = (view: AccountView, dismissed = false) =>
    renderToStaticMarkup(createElement(AccountWelcome, { view, dismissed, onSkip: noop, onOpen: noop }));
  assert.match(welcome(base), /跳过/);
  assert.equal(welcome(base, true), '');
  assert.equal(welcome(signed), '');
  assert.equal(welcome({ ...base, configured: false }), '');
  for (const sync of ['idle', 'off', 'syncing', 'offline', 'error: AUTH_REQUIRED'] as const) {
    const html = renderToStaticMarkup(createElement(AccountSyncPill, { view: { ...signed, sync }, onOpen: noop }));
    assert.equal(!!html, !['idle', 'off'].includes(sync));
  }
});

test('New-machine checklist never offers retired CLI providers', () => {
  const html = render({ ...signed, missingProviders: ['codex', 'grok', 'gemini', 'agy'] });
  assert.match(html, /Codex/);
  assert.match(html, /Grok/);
  assert.doesNotMatch(html, /gemini|Gemini|agy/);
});

test('Account checklist says Sign in and device platforms use friendly names', () => {
  const html = render({
    ...signed,
    missingProviders: ['codex'],
    devices: ['win32', 'darwin', 'linux'].map((platform) => ({
      id: platform,
      name: 'Synthetic',
      platform,
      cli_providers: [],
    })),
  });
  assert.match(html, />登录<\/button>/);
  assert.doesNotMatch(html, />设置<\/button>/);
  for (const name of ['Windows', 'macOS', 'Linux']) assert.ok(html.includes(`>${name}</span>`));
});

test('Account secondary controls use theme surfaces and the settings group spacing', () => {
  const css = readFileSync('src/ui/AccountSettings.css', 'utf8');
  const controls = css.match(/\.account-settings \.button\.secondary[^}]+}/)?.[0] ?? '';
  assert.match(controls, /background: var\(--surface-1\)/);
  assert.match(controls, /color: var\(--text\)/);
  assert.match(css, /\.account-settings > \.settings-group\s*{[^}]*margin-bottom: 0/);
});
