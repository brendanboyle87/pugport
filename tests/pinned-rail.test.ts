import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PIN_RAIL_FULL_LIMIT, pinAgeLabel, pinRailLayout, pinsNewestFirst } from '../src/shared/pinned-messages.ts';
import { fitPinnedWindow } from '../src/ui/PinnedMessageWindow.tsx';

test('the rail shows only with pins and a wide enough gutter, and turns compact above five pins', () => {
  assert.equal(pinRailLayout(400, 0).rail, false, 'no pins, no rail');
  assert.equal(pinRailLayout(219, 3).rail, false, 'narrow gutter keeps the top bar');
  assert.deepEqual(pinRailLayout(276, 3), { rail: true, compact: false, width: 200 });
  assert.equal(pinRailLayout(276, PIN_RAIL_FULL_LIMIT).compact, false);
  assert.equal(pinRailLayout(276, PIN_RAIL_FULL_LIMIT + 1).compact, true);
  assert.equal(pinRailLayout(220, 2).width, 188, 'cards shrink rather than covering the message column');
});

test('newest pin first without changing the saved order', () => {
  const pins = [
    { messageId: 'a', pinnedAt: '2026-11-01T00:00:00.000Z' },
    { messageId: 'b', pinnedAt: '2026-11-03T00:00:00.000Z' },
    { messageId: 'c', pinnedAt: '2026-11-02T00:00:00.000Z' },
  ];
  assert.deepEqual(
    pinsNewestFirst(pins).map((pin) => pin.messageId),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    pins.map((pin) => pin.messageId),
    ['a', 'b', 'c'],
  );
});

test('relative time labels', () => {
  const now = Date.parse('2026-11-04T12:00:00.000Z');
  assert.equal(pinAgeLabel('2026-11-04T11:59:40.000Z', now), '刚刚');
  assert.equal(pinAgeLabel('2026-11-04T11:15:00.000Z', now), '45 分钟前');
  assert.equal(pinAgeLabel('2026-11-04T09:00:00.000Z', now), '3 小时前');
  assert.equal(pinAgeLabel('2026-11-01T12:00:00.000Z', now), '3 天前');
  assert.equal(pinAgeLabel(undefined, now), '');
});

test('the floating window always stays inside the conversation area', () => {
  const area = { width: 1000, height: 600 };
  assert.deepEqual(fitPinnedWindow({ x: 40, y: 16, width: 560, height: 600 }, area), {
    x: 40,
    y: 16,
    width: 560,
    height: 576,
  });
  assert.deepEqual(fitPinnedWindow({ x: 900, y: 500, width: 560, height: 300 }, area), {
    x: 440,
    y: 300,
    width: 560,
    height: 300,
  });
  assert.deepEqual(fitPinnedWindow({ x: -50, y: -10, width: 100, height: 50 }, area), {
    x: 0,
    y: 0,
    width: 320,
    height: 220,
  });
  const small = fitPinnedWindow({ x: 0, y: 0, width: 560, height: 500 }, { width: 300, height: 200 });
  assert.ok(small.width <= 300 && small.height <= 200, 'a tiny area still contains the window');
});
