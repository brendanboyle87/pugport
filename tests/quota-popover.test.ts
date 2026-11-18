import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observedLabel, quotaBars, quotaLines, quotaTotals } from '../src/shared/quota-summary.ts';
import { trayPopupHtml } from '../src/electron/tray-popup.ts';
import type { QuotaWindow, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

test('quota readings show when they were taken, compactly', () => {
  const now = Date.parse('2026-10-02T12:00:00');
  assert.equal(observedLabel(null, now), '未刷新');
  assert.equal(observedLabel('2026-10-02T11:59:40', now), '刚刚');
  assert.equal(observedLabel('2026-10-02T11:57:00', now), '3 分钟前');
  assert.equal(observedLabel('2026-10-02T09:05:00', now), '09:05');
});

const runtime = (id: string, provider: RuntimeSnapshot['provider'], used: (number | null)[]) =>
  ({
    id,
    provider,
    label: id,
    status: 'ready',
    quota: {
      observedAt: '2026-10-02T11:59:00',
      windows: used.map((usedPercent, index) => ({
        id: String(index),
        label: 'w',
        usedPercent,
        resetsAt: null,
        durationMinutes: index ? 10080 : 300,
      })),
    },
  }) as unknown as RuntimeSnapshot;
const target = (id: string, enabled = true) => ({ id, enabled }) as RuntimeTarget;

test('each account is limited by its tightest window, and platforms add up their accounts', () => {
  const runtimes = [
    runtime('codex-native', 'codex', [10, 53]),
    runtime('codex-b', 'codex', [0, 67]),
    runtime('grok-native', 'grok', [null]),
    runtime('claude-native', 'claude', [12, 10]),
  ];
  const lines = quotaLines(runtimes, [
    target('codex-native'),
    target('codex-b'),
    target('grok-native'),
    target('claude-native', false),
  ]);
  assert.deepEqual(
    lines.map((line) => [line.id, line.tightest, line.windows.map((w) => w.name).join('/')]),
    [
      ['codex-native', 47, '5h/周'],
      ['codex-b', 33, '5h/周'],
      ['grok-native', undefined, '5h'],
    ],
  );
  assert.deepEqual(quotaTotals(lines), [
    { provider: 'codex', accounts: 2, known: 2, total: 0.8 },
    { provider: 'grok', accounts: 1, known: 0, total: 0 },
  ]);
  const html = trayPopupHtml({ running: 2, lines, totals: quotaTotals(lines) }, Date.parse('2026-10-02T12:00:00'));
  assert.match(html, /2 个 Agent 任务运行中/);
  assert.match(html, /<b>Codex<\/b> 80%/);
  assert.match(html, /周<\/span> <b style="color:[^"]+">47%<\/b>/);
  // One bar per account here (no separate pools): the weekly window, or the 5-hour one once it runs low.
  assert.equal((html.match(/<div class="bar">/g) ?? []).length, lines.length);
  assert.deepEqual(
    lines.map((line) => line.bars),
    [[47], [33], [undefined]],
    'codex-b shows its 5-hour window (0% left) instead of the weekly 33%',
  );
  assert.doesNotMatch(html, /<script/);
});

test('bars: weekly by default, the 5-hour window when under 15%, every separate pool its own', () => {
  const window = (id: string, used: number, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
    id,
    label: id,
    usedPercent: used,
    resetsAt: null,
    ...extra,
  });
  const fiveHours = (used: number) => window('5h', used, { durationMinutes: 300 });
  const week = (used: number) => window('week', used, { durationMinutes: 10080 });
  const fable = window('fable', 5, { durationMinutes: 10080, modelFamily: 'fable' });
  assert.deepEqual(quotaBars([fiveHours(9), week(9), fable], 91), [91], 'Claude: one weekly bar, not three');
  assert.deepEqual(quotaBars([fiveHours(90), week(20), fable], 10), [10], 'a nearly spent 5-hour window takes over');
  assert.deepEqual(quotaBars([fiveHours(84), week(20)], 16), [80], 'at 16% left the weekly bar stays');
  assert.deepEqual(
    quotaBars([window('cursor', 0, { modelPool: 'cursor' }), window('other', 40, { modelPool: 'other' })], 60),
    [100, 60],
  );
  assert.deepEqual(quotaBars([window('day', 30, { durationMinutes: 1440 })], 70), [70], 'otherwise the tightest share');
});
