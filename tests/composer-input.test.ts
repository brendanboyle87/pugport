import assert from 'node:assert/strict';
import test from 'node:test';
import { composerEnterAction } from '../src/shared/composer-enter.ts';

const idle = { active: false, endedAt: -Infinity };
const enter = { key: 'Enter', shiftKey: false };

test('Enter sends and Shift+Enter inserts a newline without changing other keys', () => {
  assert.equal(composerEnterAction(enter, idle, 1000), 'send');
  assert.equal(composerEnterAction({ ...enter, shiftKey: true }, idle, 1000), 'newline');
  assert.equal(composerEnterAction({ key: 'a', shiftKey: false }, idle, 1000), 'other');
  assert.equal(composerEnterAction({ ...enter, repeat: true }, idle, 1000), 'ignore');
  assert.equal(composerEnterAction({ ...enter, altKey: true }, idle, 1000), 'ignore');
});

test('Command+Enter sends with the configured modifier shortcut and still respects IME and Alt', () => {
  assert.equal(composerEnterAction({ ...enter, metaKey: true }, idle, 1000, 'ctrl-enter'), 'send');
  assert.equal(composerEnterAction({ ...enter, metaKey: true, shiftKey: true }, idle, 1000, 'ctrl-enter'), 'send');
  assert.equal(
    composerEnterAction({ ...enter, metaKey: true, isComposing: true }, idle, 1000, 'ctrl-enter'),
    'composition',
  );
  assert.equal(composerEnterAction({ ...enter, metaKey: true, altKey: true }, idle, 1000, 'ctrl-enter'), 'ignore');
});

test('IME candidate confirmation never becomes a send even when native composition flags disagree', () => {
  for (const shiftKey of [false, true]) {
    assert.equal(composerEnterAction({ ...enter, shiftKey, isComposing: true }, idle, 1000), 'composition');
    assert.equal(composerEnterAction({ ...enter, shiftKey, keyCode: 229 }, idle, 1000), 'composition');
    assert.equal(
      composerEnterAction({ ...enter, shiftKey }, { active: true, endedAt: -Infinity }, 1000),
      'composition',
    );
  }
});

test('compositionend followed by Enter is suppressed until key release or the short guard expires', () => {
  const justEnded = { active: false, endedAt: 1000 };
  assert.equal(composerEnterAction(enter, justEnded, 1000), 'ignore');
  assert.equal(composerEnterAction(enter, justEnded, 1039), 'ignore');
  assert.equal(composerEnterAction(enter, { ...justEnded, endedAt: -Infinity }, 1001), 'send');
  // A quick typist's Enter right after choosing the last character is sent.
  assert.equal(composerEnterAction(enter, justEnded, 1040), 'send');
  assert.equal(composerEnterAction(enter, justEnded, 1080), 'send');
  assert.equal(composerEnterAction({ ...enter, shiftKey: true }, justEnded, 1040), 'newline');
});
