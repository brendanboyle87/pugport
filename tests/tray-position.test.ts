import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitTrayPopup, trayPopupBounds } from '../src/electron/tray-position.ts';

const primary = {
  bounds: { x: 0, y: 0, width: 1707, height: 1067 },
  workArea: { x: 0, y: 0, width: 1707, height: 1019 },
};

test('the 150% Windows display uses DIP once and a bottom card meets the work area', () => {
  const bounds = trayPopupBounds({ x: 1360, y: 1023, width: 24, height: 24 }, primary, { width: 340, height: 500 });
  assert.deepEqual(bounds, { x: 1202, y: 519, width: 340, height: 500 });
  assert.equal(bounds.y + bounds.height, 1019, 'Only the card’s own six-DIP border margin remains above the taskbar');
});

test('a negative-coordinate screen stays on the tray display without primary-screen assumptions', () => {
  const bounds = trayPopupBounds(
    { x: -50, y: 1407, width: 24, height: 24 },
    { bounds: { x: -2560, y: 7, width: 2560, height: 1440 }, workArea: { x: -2560, y: 7, width: 2560, height: 1392 } },
    { width: 340, height: 500 },
  );
  assert.deepEqual(bounds, { x: -340, y: 899, width: 340, height: 500 });
});

test('top and side taskbars put the popup beside the reserved edge', () => {
  const size = { width: 340, height: 500 };
  const top = trayPopupBounds(
    { x: 1100, y: 8, width: 24, height: 24 },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 48, width: 1920, height: 1032 } },
    size,
  );
  assert.equal(top.y, 48);
  const left = trayPopupBounds(
    { x: -1912, y: 1000, width: 24, height: 24 },
    { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1872, y: 0, width: 1872, height: 1080 } },
    size,
  );
  assert.equal(left.x, -1872);
  assert.equal(left.y + left.height, 1080);
  const right = trayPopupBounds(
    { x: 1880, y: 1000, width: 24, height: 24 },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1872, height: 1080 } },
    size,
  );
  assert.equal(right.x + right.width, 1872);
});

test('auto-hide and separately reserved desktop strips stay near the actual taskbar icon', () => {
  const icon = { x: 1360, y: 1023, width: 24, height: 24 };
  const size = { width: 340, height: 500 };
  const autoHide = trayPopupBounds(icon, { bounds: primary.bounds, workArea: primary.bounds }, size);
  assert.equal(autoHide.y + autoHide.height, 1067);
  const extraStrip = trayPopupBounds(icon, { ...primary, workArea: { ...primary.workArea, height: 930 } }, size);
  assert.equal(extraStrip.y + extraStrip.height, icon.y);
});

test('oversized cards remain usable on a short or narrow monitor', () => {
  const area = { x: -300, y: 40, width: 280, height: 280 };
  const bounds = trayPopupBounds(
    { x: -50, y: 328, width: 20, height: 20 },
    { bounds: { ...area, height: 320 }, workArea: area },
    { width: 340, height: 700 },
  );
  assert.deepEqual(bounds, area);
});

test('live resize preserves the dragged position and clamps only when the screen no longer fits', () => {
  assert.deepEqual(fitTrayPopup({ x: 200, y: 100, width: 340, height: 510 }, primary.workArea), {
    x: 200,
    y: 100,
    width: 340,
    height: 510,
  });
  assert.deepEqual(fitTrayPopup({ x: 1600, y: 900, width: 340, height: 510 }, primary.workArea), {
    x: 1367,
    y: 509,
    width: 340,
    height: 510,
  });
});
