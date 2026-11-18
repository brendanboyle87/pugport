import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { defaultRequestMethod } from '../src/ui/backend-session.ts';

test('a call without a body is a read, a call with one is a write', () => {
  assert.equal(defaultRequestMethod(undefined), 'GET');
  assert.equal(defaultRequestMethod({}), 'POST');
  assert.equal(defaultRequestMethod(null), 'POST');
});

// The fix landed once in App's helper while Studio's wrapper kept a fixed 'POST' default, so running tasks
// POSTed their detail load and always showed 「详情暂时不可用」. Every wrapper must use the shared default.
test('no UI api wrapper hardcodes a POST default', () => {
  for (const file of ['src/ui/App.tsx', 'src/ui/Studio.tsx']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /method = defaultRequestMethod\(body\)/, file);
    assert.doesNotMatch(source, /body\?: unknown,\s*method = 'POST'/, file);
  }
});
