import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression: brand-electron.mjs exited the build once Electron was already branded, so the UI release was never
// published and the app showed "No compatible UI build". Optional steps run after publishing and never exit.
test('the build publishes the UI before optional steps, and imported scripts never exit the build', () => {
  const build = readFileSync('scripts/build.mjs', 'utf8');
  const publish = build.indexOf('await saveUiBaseline(');
  assert.ok(publish > 0);
  assert.ok(build.indexOf('brand-electron.mjs') > publish, 'branding runs after the UI release is published');
  for (const imported of build.matchAll(/import\('\.\/([\w-]+\.mjs)'\)/g))
    assert.doesNotMatch(readFileSync(`scripts/${imported[1]}`, 'utf8'), /process\.exit\(/, imported[1]);
});
