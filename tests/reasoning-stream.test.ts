import assert from 'node:assert/strict';
import test from 'node:test';
import { createFollowBottom } from '../src/ui/follow-bottom.ts';

test('reasoning follows growing content at the bottom, including the first overflow', () => {
  const follow = createFollowBottom();
  const pane = { scrollTop: 0, scrollHeight: 80, clientHeight: 100 };
  follow.update(pane);
  assert.equal(pane.scrollTop, 0);
  pane.scrollHeight = 180;
  follow.update(pane);
  assert.equal(pane.scrollTop, 80);
  follow.onScroll(pane);
  pane.scrollHeight = 320;
  follow.update(pane);
  assert.equal(pane.scrollTop, 220);
});

test('scrolling up preserves the reading position through chunks until the reader returns to the bottom', () => {
  const follow = createFollowBottom();
  const pane = { scrollTop: 0, scrollHeight: 500, clientHeight: 100 };
  follow.update(pane);
  pane.scrollTop = 260;
  follow.onScroll(pane);
  for (const scrollHeight of [600, 800, 1200]) {
    pane.scrollHeight = scrollHeight;
    follow.update(pane);
    assert.equal(pane.scrollTop, 260);
  }
  pane.scrollTop = 1100;
  follow.onScroll(pane);
  pane.scrollHeight = 1300;
  follow.update(pane);
  assert.equal(pane.scrollTop, 1200);
});

test('fractional bottom coordinates keep following, while a small deliberate upward scroll pauses it', () => {
  const follow = createFollowBottom();
  const pane = { scrollTop: 399.5, scrollHeight: 500, clientHeight: 100 };
  follow.onScroll(pane);
  pane.scrollHeight = 600;
  follow.update(pane);
  assert.equal(pane.scrollTop, 500);
  pane.scrollTop = 498;
  follow.onScroll(pane);
  pane.scrollHeight = 700;
  follow.update(pane);
  assert.equal(pane.scrollTop, 498);
});

test('collapse and reopen retain following or paused state, and new runs start following independently', () => {
  const follow = createFollowBottom();
  const pane = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 };
  pane.clientHeight = 0;
  follow.onScroll(pane);
  pane.scrollHeight = 700;
  follow.update(pane);
  assert.equal(pane.scrollTop, 400);
  pane.clientHeight = 100;
  follow.update(pane);
  assert.equal(pane.scrollTop, 600);
  pane.scrollTop = 250;
  follow.onScroll(pane);
  pane.clientHeight = 0;
  follow.onScroll(pane);
  pane.scrollHeight = 800;
  pane.clientHeight = 100;
  follow.update(pane);
  assert.equal(pane.scrollTop, 250);
  createFollowBottom().update(pane);
  assert.equal(pane.scrollTop, 700);
});
