import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trayPopupHtml, trayResourcesHtml, type TrayData } from '../src/electron/tray-popup.ts';
import type { SystemResources } from '../src/electron/system-monitor.ts';

const empty: TrayData = { running: 0, lines: [], totals: [] };
const GiB = 1024 ** 3;

test('tray popup reserves three local resource cells above quotas with stable update targets', () => {
  const html = trayPopupHtml(empty, 0);
  assert.equal((html.match(/id="system-resources"/g) ?? []).length, 1);
  assert.equal((html.match(/id="quota-content"/g) ?? []).length, 1);
  assert.equal((html.match(/id="tray-actions"/g) ?? []).length, 1);
  assert.ok(html.indexOf('id="system-resources"') < html.indexOf('id="quota-content"'));
  assert.equal((html.match(/class="resource"/g) ?? []).length, 3);
  const parts = [...html.matchAll(/data-resource-part="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(parts).size, parts.length);
  for (const resource of ['cpu', 'gpu', 'memory']) {
    assert.match(html, new RegExp(`data-resource-part="${resource}-value">—</b>`));
    assert.match(html, new RegExp(`data-resource-part="${resource}-bar" style="width:0%;opacity:0"`));
  }
  assert.match(html, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /transition:width 250ms ease,opacity 250ms ease/);
  assert.doesNotMatch(html, /<script\b/);
});

test('tray resources display rounded use and physical memory in GiB', () => {
  const html = trayResourcesHtml({
    cpuPercent: 12.4,
    gpuPercent: 42.7,
    memory: { usedBytes: 12.25 * GiB, totalBytes: 32 * GiB, percent: 38.28125 },
    observedAt: 123,
    gpuState: 'available',
  });
  assert.match(html, /data-resource-part="cpu-value">12%/);
  assert.match(html, /data-resource-part="gpu-value">43%/);
  assert.match(html, /data-resource-part="memory-value">38%/);
  assert.match(html, /data-resource-part="memory-detail">12\.3 \/ 32\.0 GiB/);
  assert.match(html, /data-resource-part="gpu-detail">—/);
  assert.match(html, /data-resource-part="gpu-bar" style="width:42\.7%;opacity:1"/);
});

test('an idle available GPU is shown as zero while unavailable readings stay unknown', () => {
  const idle = trayResourcesHtml({ gpuPercent: 0, gpuState: 'available', observedAt: 123 });
  assert.match(idle, /data-resource-part="gpu-value">0%/);
  assert.match(idle, /data-resource-part="gpu-detail">—/);
  const unavailable = trayResourcesHtml({ gpuState: 'unavailable', observedAt: 123 });
  assert.match(unavailable, /data-resource-part="gpu-value">—/);
  assert.match(unavailable, /data-resource-part="gpu-detail">暂不可用/);
  assert.match(unavailable, /系统暂未提供 GPU 占用，无法读取时不会显示为 0%。/);
  assert.match(trayResourcesHtml(), /data-resource-part="gpu-detail">读取中/);
});

test('invalid resource numbers never render NaN, infinity, or a false known memory value', () => {
  const html = trayResourcesHtml({
    cpuPercent: Number.NaN,
    gpuPercent: Number.POSITIVE_INFINITY,
    memory: { usedBytes: 1, totalBytes: 0, percent: Number.NaN },
    observedAt: 123,
    gpuState: 'unavailable',
  });
  for (const resource of ['cpu', 'gpu', 'memory']) {
    assert.match(html, new RegExp(`data-resource-part="${resource}-value">—`));
  }
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  assert.match(html, /data-resource-part="memory-detail">—/);
});

test('resource percentages stay in physical bounds and invalid memory percentage is derived', () => {
  const html = trayResourcesHtml({
    cpuPercent: 150,
    gpuPercent: -5,
    memory: { usedBytes: GiB, totalBytes: 4 * GiB, percent: Number.NaN },
    observedAt: 123,
    gpuState: 'available',
  });
  assert.match(html, /data-resource-part="cpu-value">100%/);
  assert.match(html, /data-resource-part="cpu-bar" style="width:100%;opacity:1"/);
  assert.match(html, /data-resource-part="gpu-value">0%/);
  assert.match(html, /data-resource-part="memory-value">25%/);
  const inconsistent = trayResourcesHtml({
    memory: { usedBytes: 5 * GiB, totalBytes: 4 * GiB, percent: 125 },
    observedAt: 123,
    gpuState: 'unavailable',
  });
  assert.match(inconsistent, /data-resource-part="memory-value">100%/);
  assert.match(inconsistent, /data-resource-part="memory-detail">4\.0 \/ 4\.0 GiB/);
});

test('quota names are escaped and malformed resource values cannot introduce HTML', () => {
  const html = trayPopupHtml(
    {
      ...empty,
      lines: [
        {
          id: 'account',
          provider: 'codex',
          label: '<img src=x onerror="alert(1)">',
          windows: [{ name: 'week & <unsafe>', remaining: 80 }],
          tightest: 80,
          observedAt: null,
        },
      ],
    },
    0,
    { cpuPercent: '<img>', gpuPercent: '<script>', observedAt: 0 } as unknown as SystemResources,
  );
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /&amp;/);
  assert.doesNotMatch(html, /<img\b|<script\b/);
  assert.match(html, /data-resource-part="cpu-value">—/);
  assert.match(html, /data-resource-part="gpu-value">—/);
});

test('long account names have their own line and quota windows can wrap below', () => {
  const html = trayPopupHtml({
    ...empty,
    lines: [
      {
        id: 'cursor',
        label: 'Cursor · 本机工作账号',
        provider: 'cursor',
        windows: [
          { name: 'Cursor Models', remaining: 100 },
          { name: 'Other Models', remaining: 95 },
        ],
        tightest: 95,
        observedAt: null,
      },
    ],
  });
  assert.match(
    html,
    /class="name" title="Cursor · 本机工作账号">Cursor · 本机工作账号<\/span><time>未刷新<\/time><\/div><div class="windows">/,
  );
  assert.match(html, /grid-template-columns:minmax\(0,1fr\) auto;/);
  assert.match(html, /\.windows\{display:flex;flex-wrap:wrap;/);
  const text = html.replace(/<[^>]*>/g, '');
  assert.match(text, /Cursor Models 100%/);
  assert.match(text, /Other Models 95%/);
});

test('each separate pool label starts above its own bar', () => {
  const html = trayPopupHtml({
    ...empty,
    lines: [
      {
        id: 'cursor',
        label: 'Cursor · 本机',
        provider: 'cursor',
        windows: [
          { name: 'Cursor Models', remaining: 100 },
          { name: 'Other Models', remaining: 100 },
        ],
        tightest: 100,
        bars: [100, 100],
        observedAt: null,
      },
    ],
  });
  assert.match(html, /<div class="windows split" style="grid-template-columns:repeat\(2,minmax\(0,1fr\)\)">/);
  assert.match(html, /\.windows\.split\{display:grid;gap:3px 4px\}/);
  assert.match(html, /\.bars\{display:flex;gap:4px;/);
});

test('local and Agent work are distinct, escaped activities with motion reduction and a drag handle', () => {
  const html = trayPopupHtml({
    ...empty,
    running: 2,
    localRunning: 1,
    localTitle: '本地媒体分析',
    localPhase: '<unsafe> 正在核验',
  });
  assert.match(html, /2 个 Agent 任务运行中/);
  assert.match(html, /class="live local"[^>]*>.*本地媒体分析/);
  assert.match(html, /&lt;unsafe&gt; 正在核验/);
  assert.doesNotMatch(html, /<unsafe>/);
  assert.match(html, /\.live\.local i\{background:#60A5FA\}/);
  assert.match(html, /prefers-reduced-motion:reduce.*\.live i\{animation:none\}/);
  assert.match(html, /data-resource-part="drag-region" title="拖动可移动窗口"/);
  assert.match(html, /a\{-webkit-app-region:no-drag;app-region:no-drag\}/);
  assert.doesNotMatch(trayPopupHtml({ ...empty, localRunning: 1 }), /class="idle">空闲/);
});

test('a delayed GPU observation retains the last known reading and explains its age', () => {
  const html = trayResourcesHtml({ gpuPercent: 42, gpuState: 'stale', gpuObservedAt: 123, observedAt: 999 });
  assert.match(html, /data-resource-part="gpu-value">42%/);
  assert.match(html, /data-resource-part="gpu-detail">等待更新/);
  assert.match(html, /保留上次 GPU 读数，正在等待更新。/);
});

test('a used-up account says when it comes back, in days or hours', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const line = (id: string, hours: number, remaining = 0) => ({
    id,
    provider: 'codex' as const,
    label: id,
    windows: [
      { name: '5h', remaining: 100, resetsAt: new Date(now + 3_600_000).toISOString() },
      { name: '周', remaining, resetsAt: new Date(now + hours * 3_600_000).toISOString() },
    ],
    tightest: remaining,
    observedAt: null,
  });
  const html = trayPopupHtml(
    { running: 0, totals: [], lines: [line('Week out', 60), line('Soon back', 2.5), line('Still left', 60, 40)] },
    now,
  );
  assert.match(html, /Week out<\/span>.*?<small>3 天后重置<\/small>/);
  assert.match(html, /Soon back<\/span>.*?<small>2 小时 30 分钟后重置<\/small>/);
  assert.doesNotMatch(html, /Still left<\/span>.*?<small>/);
});
