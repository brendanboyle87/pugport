import assert from 'node:assert/strict';
import test from 'node:test';
import { appNavigationAllowed } from '../src/electron/navigation.ts';

test('navigation permits only the app root and its popup queries', () => {
  const origin = 'http://127.0.0.1:4317';
  for (const [destination, allowed] of [
    [`${origin}/`, true],
    [`${origin}/?view=x`, true],
    [`${origin}/api/files/x`, false],
    [`${origin}/other`, false],
    ['http://127.0.0.1:9999/', false],
    ['not a url', false],
  ] as const)
    assert.equal(appNavigationAllowed(destination, origin), allowed, destination);
});
