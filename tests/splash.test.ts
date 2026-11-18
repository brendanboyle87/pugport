import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splashHtml } from '../src/electron/splash.ts';

test('the startup screen shows the pug running to its bone, and the error screen a still pug', () => {
  const starting = splashHtml('正在启动…', false, 'data:image/png;base64,AAAA');
  assert.match(
    starting,
    /<div class="scene"[\s\S]*class="bone"[\s\S]*<div class="pug"><img src="data:image\/png;base64,AAAA"/,
  );
  assert.match(starting, /window\.pugportReady = \(\) =>/);
  assert.match(starting, /background:#121316/);
  assert.match(starting, /@media \(prefers-color-scheme:light\).*background:#F3F3F5/);
  // The run eases toward the bone without reaching it; only readiness lets the pug grab it.
  assert.match(starting, /reach \* 0\.85/);
  const failed = splashHtml('<后台> 不可用', true, 'data:image/png;base64,AAAA');
  assert.doesNotMatch(failed, /<script>|class="scene"/);
  assert.match(failed, /class="still"[\s\S]*&lt;后台&gt; 不可用/);
});
