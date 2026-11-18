import assert from 'node:assert/strict';
import { test } from 'node:test';
import { electronModule } from './helpers/electron-harness.ts';
import { trayResourcesHtml } from '../src/electron/tray-popup.ts';

test('tray resource labels and accessible names follow the selected language', async () => {
  const locale = await electronModule('src/electron/locale.ts', { app: {} });
  const html = '<section aria-label="本机资源" title="本机物理内存占用。"><strong>本机资源</strong></section>';
  locale.setMainLocale('en', false);
  const translated = locale.translateHtml(html);
  assert.match(translated, /aria-label="System resources"/);
  assert.match(translated, /<strong>System resources<\/strong>/);
  assert.match(translated, /title="Physical memory usage on this computer\."/);
  locale.setMainLocale('zh-CN', false);
  assert.equal(locale.translateHtml(html), html);
});

test('CPU overflow metadata follows the locale together with the visible detail', async () => {
  const locale = await electronModule('src/electron/locale.ts', { app: {} });
  locale.setMainLocale('en', false);
  const html = locale.translateHtml(
    trayResourcesHtml({ observedAt: 0, cpu: { model: 'Apple M3 Pro', cores: 12, threads: 12 } }),
  );
  assert.match(html, /data-full="Apple M3 Pro · 12 cores, 12 threads"/);
  assert.match(html, /cpu-detail">Apple M3 Pro · 12 cores, 12 threads/);
});

test('running task labels are count-neutral in English, including the tray HTML', async () => {
  const locale = await electronModule('src/electron/locale.ts', { app: {} });
  locale.setMainLocale('en', false);
  for (const count of [1, 2]) {
    assert.equal(locale.t(`${count} 个 Agent 任务运行中`), `Agent tasks running: ${count}`);
    assert.equal(
      locale.translateHtml(
        `<span class="live"><i></i><span class="live-label">${count} 个 Agent 任务运行中</span></span>`,
      ),
      `<span class="live"><i></i><span class="live-label">Agent tasks running: ${count}</span></span>`,
    );
  }
});

test('simplified tray actions and combined task status use natural English', async () => {
  const locale = await electronModule('src/electron/locale.ts', { app: {} });
  locale.setMainLocale('en', false);
  assert.equal(locale.t('立即黑屏'), 'Black out now');
  assert.equal(locale.t('不休眠'), 'Keep awake');
  assert.equal(locale.t('1 个任务运行中'), 'Tasks running: 1');
  assert.equal(locale.t('5 个任务运行中'), 'Tasks running: 5');
  assert.equal(locale.t('当前没有运行中的任务'), 'No running tasks');
});
