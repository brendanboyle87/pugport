import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLaunchArgsMode, formatLaunchArgs, linesAreLossless, parseLaunchArgs } from '../src/ui/launch-args.ts';

test('plain arguments use line mode and round-trip exactly', () => {
  const args = ['--profile', 'work', '-c', 'model="gpt"'];
  assert.equal(defaultLaunchArgsMode(args), 'lines');
  assert.deepEqual(parseLaunchArgs(formatLaunchArgs(args, 'lines'), 'lines'), args);
});

test('arguments that line mode would alter fall back to exact JSON editing', () => {
  const multiLineCommand = ['-NoProfile', '-Command', '$a = 1\n$b = 2\nWrite-Output ($a + $b)'];
  for (const args of [multiLineCommand, ['--flag', ''], ['  padded  '], ['a\r\nb']]) {
    assert.equal(linesAreLossless(args), false);
    assert.equal(defaultLaunchArgsMode(args), 'json');
    assert.deepEqual(parseLaunchArgs(formatLaunchArgs(args, 'json'), 'json'), args);
  }
});

test('line mode ignores blank lines and surrounding spaces the user typed', () => {
  assert.deepEqual(parseLaunchArgs(' --a \n\n  b\r\n', 'lines'), ['--a', 'b']);
  assert.deepEqual(parseLaunchArgs('', 'lines'), []);
});

test('JSON mode rejects anything but a string array with a readable message', () => {
  assert.deepEqual(parseLaunchArgs('  ', 'json'), []);
  for (const text of ['not json', '{"a":1}', '[1, 2]', '["ok", null]'])
    assert.throws(() => parseLaunchArgs(text, 'json'), /JSON 字符串数组/);
});
