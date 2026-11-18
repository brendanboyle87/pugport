import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  composerEfforts,
  EffortSlider,
  localInputAt,
  ModeChip,
  ModeMenu,
  spanUntil,
} from '../src/ui/ComposerControls.tsx';
import type { RouteDecision, RuntimeSnapshot } from '../src/shared/types.ts';

test('timer wheels convert between "time from now" and the queue\'s local date-time text', () => {
  const now = new Date(2026, 8, 30, 10, 0).getTime();
  const later = localInputAt(now + ((2 * 24 + 3) * 60 + 15) * 60_000);
  assert.equal(later, '2026-10-02T13:15');
  assert.deepEqual(spanUntil(later, now), { days: 2, hours: 3, minutes: 15 });
  assert.deepEqual(spanUntil('', now), { days: 0, hours: 0, minutes: 0 });
  assert.deepEqual(spanUntil(localInputAt(now - 60_000), now), { days: 0, hours: 0, minutes: 0 });
  for (const seconds of [0, 29, 30, 59]) {
    const opened = now + seconds * 1000;
    assert.deepEqual(spanUntil(localInputAt(opened + 5 * 60_000), opened), { days: 0, hours: 0, minutes: 5 });
  }
});

test('effort slider starts at automatic and marks only the strongest level as the top level', () => {
  const render = (value: string) =>
    renderToStaticMarkup(
      createElement(EffortSlider, { levels: ['low', 'medium', 'high', 'xhigh'], value, onChange() {} }),
    );
  assert.match(render(''), /aria-valuetext="自动"/);
  assert.doesNotMatch(render('high'), /effort-top/);
  assert.match(render('xhigh'), /effort-slider effort-top/);
});

test('effort labels cover every CLI/API level while retaining the raw value and each slider step', () => {
  const labels = {
    none: '关闭思考',
    off: '关闭思考',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '很高',
    max: '最高',
    ultra: '极限',
  };
  for (const [value, label] of Object.entries(labels)) {
    const html = renderToStaticMarkup(
      createElement(EffortSlider, { levels: Object.keys(labels), value, onChange() {} }),
    );
    assert.match(html, new RegExp(`aria-valuetext="${label}"`));
    assert.match(html, /max="9" step="1"/);
  }
});

test('automatic-model levels prefer a matching proposal, then reported default, then the catalog union', () => {
  const runtime = {
    id: 'fixture',
    defaultModel: 'default',
    models: [
      { id: 'default', label: 'Default', efforts: ['high', 'low'] },
      { id: 'proposed', label: 'Proposed', efforts: ['max', 'medium'] },
      { id: 'no-effort', label: 'No effort', efforts: [] },
    ],
  } as RuntimeSnapshot;
  const proposal = { runtimeId: runtime.id, model: 'proposed' } as RouteDecision;
  assert.deepEqual(composerEfforts(runtime, '', proposal).levels, ['medium', 'max']);
  assert.deepEqual(composerEfforts(runtime, '').levels, ['low', 'high']);
  assert.deepEqual(composerEfforts(runtime, '', { ...proposal, runtimeId: 'other' }).levels, ['low', 'high']);
  assert.deepEqual(composerEfforts(runtime, 'proposed').levels, ['medium', 'max']);
  assert.deepEqual(composerEfforts(runtime, 'no-effort').levels, []);
  assert.deepEqual(composerEfforts(runtime, 'missing').levels, []);
  assert.deepEqual(composerEfforts(undefined, '').levels, []);
  const fallback = composerEfforts({ ...runtime, defaultModel: undefined }, '');
  assert.deepEqual(fallback.levels, ['low', 'medium', 'high', 'max']);
  assert.match(fallback.title!, /最近强度/);
  assert.deepEqual(composerEfforts(runtime, '', { ...proposal, model: 'no-effort' }).levels, []);
});

test('mode chip is a quiet icon in Normal, a tag with × otherwise, and locks while a turn runs', () => {
  const chip = (props: Partial<Parameters<typeof ModeChip>[0]>) =>
    renderToStaticMarkup(createElement(ModeChip, { open: false, onToggle() {}, onClear() {}, ...props }));
  const normal = chip({});
  assert.match(normal, /class="composer-mode"/);
  assert.match(normal, /title="模式：普通"/);
  assert.doesNotMatch(normal, /普通</, 'Normal shows no label');
  assert.doesNotMatch(normal, /disabled/);
  const navigator = chip({ mode: 'navigator', open: true });
  assert.match(navigator, /composer-tag composer-mode-tag open/);
  assert.match(navigator, />领航</);
  assert.match(navigator, /aria-expanded="true"/);
  assert.match(navigator, /aria-label="改回普通模式"/);
  const running = chip({ mode: 'mods-author', disabled: true });
  assert.equal(running.match(/disabled=""/g)?.length, 2, 'both the tag and its × are locked');
  assert.match(running, /从下一条消息开始生效/);
  assert.match(chip({ disabled: true }), /disabled=""/);
});

test('mode menu lists Normal, Mods author and Navigator with the current one checked', () => {
  const html = renderToStaticMarkup(createElement(ModeMenu, { mode: 'mods-author', onPick() {} }));
  assert.deepEqual(
    [...html.matchAll(/role="menuitemradio" aria-checked="(true|false)"/g)].map((match) => match[1]),
    ['false', 'true', 'false'],
  );
  for (const label of ['普通', 'Mod 作者', '领航']) assert.match(html, new RegExp(`<span>${label}</span>`));
  assert.match(renderToStaticMarkup(createElement(ModeMenu, { onPick() {} })), /aria-checked="true"[^>]*><svg/);
});

test('Navigator shows its saved route on the chip and offers one setting in the menu', () => {
  const chip = renderToStaticMarkup(
    createElement(ModeChip, {
      mode: 'navigator',
      open: false,
      onToggle() {},
      onClear() {},
      detail: 'Opus 5.5 · 高',
    }),
  );
  assert.match(chip, />领航<span class="composer-mode-detail">· Opus 5\.5 · 高<\/span>/);
  const menu = (mode?: 'navigator' | 'mods-author', route?: string) =>
    renderToStaticMarkup(createElement(ModeMenu, { mode, onPick() {}, route, onChooseRoute() {} }));
  assert.match(menu('navigator'), /领航员使用：<span class="composer-mode-route">自动<\/span>/);
  assert.match(menu('navigator', 'Opus 5.5'), /<span class="composer-mode-route">Opus 5\.5<\/span>/);
  assert.match(menu('navigator'), /role="menuitem"[^>]*class="composer-mode-setting"/);
  for (const mode of [undefined, 'mods-author'] as const)
    assert.doesNotMatch(menu(mode), /composer-mode-setting/, 'only Navigator has a setting');
});

test('Mods author offers one setting: its folder, the default area until Change… picks another', () => {
  const menu = (mode?: 'navigator' | 'mods-author', folder?: string) =>
    renderToStaticMarkup(createElement(ModeMenu, { mode, onPick() {}, folder, onChangeFolder() {} }));
  assert.match(menu('mods-author'), /文件夹：<span class="composer-mode-route">PugPort 数据 › mods-workspace<\/span>/);
  assert.match(
    menu('mods-author', 'english-speaking'),
    />english-speaking<\/span><span class="composer-mode-choose"> · 更改…/,
  );
  assert.doesNotMatch(menu('navigator'), /文件夹：/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ModeMenu, { mode: 'mods-author', onPick() {} })), /文件夹：/);
});
