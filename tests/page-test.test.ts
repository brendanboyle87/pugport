import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppPageRequest, localPageUrl } from '../src/shared/local-page.ts';
import { cleanSteps, describe, testPage } from '../src/server/page-test-client.ts';

test('page tests open pages on this computer only', () => {
  for (const url of [
    'http://localhost:5173/',
    'https://127.0.0.1:8443/app',
    'http://[::1]:3000',
    'http://app.localhost/',
    'file:///C:/site/index.html',
  ])
    assert.ok(localPageUrl(url), url);
  for (const url of [
    'https://example.com',
    'http://192.168.1.5/',
    'http://localhost.evil.com/',
    'javascript:alert(1)',
    'not a url',
  ])
    assert.ok(!localPageUrl(url), url);
});

test('steps are checked before anything runs', async () => {
  assert.deepEqual(
    cleanSteps([
      { action: 'click', target: '开始游戏', extra: 1 },
      { action: 'wait', ms: 99_999 },
    ]),
    [
      { action: 'click', target: '开始游戏' },
      { action: 'wait', ms: 10_000 },
    ],
  );
  assert.throws(() => cleanSteps([]), /steps/);
  assert.throws(() => cleanSteps([{ action: 'drag' }]), /第 1 步的 action 不认识/);
  await assert.rejects(
    testPage({ url: 'https://example.com', steps: [{ action: 'click', target: 'x' }] }),
    /只能测试本机页面/,
  );
  // Outside the desktop app there is no browser to drive.
  await assert.rejects(
    testPage({ url: 'http://localhost:5173/', steps: [{ action: 'expect_text', text: 'x' }] }),
    /桌面版/,
  );
});

test('read-only page callers cannot click, type or press even when tool arguments claim writable access', async () => {
  for (const action of ['click', 'type', 'press'])
    await assert.rejects(
      testPage(
        { url: 'http://localhost:5173/', steps: [{ action, target: 'x', text: 'x', key: 'Enter' }], readOnly: false },
        { readOnly: true },
      ),
      /这次运行是只读/,
    );
  await assert.rejects(
    testPage({ url: 'http://localhost:5173/', steps: [{ action: 'expect_text', text: 'x' }] }, { readOnly: true }),
    /桌面版/,
  );
});

test('the private app boundary includes normalized loopback aliases and websockets', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1', '2130706433', '0x7f000001', '[::1]']) {
    assert.ok(isAppPageRequest(`http://${host}:43123/api/session`, 43123), host);
    assert.ok(isAppPageRequest(`ws://${host}:43123/`, 43123), host);
  }
  for (const url of [
    'http://localhost:5173/',
    'https://example.com:43123/',
    'file:///C:/site/index.html',
    'http://localhost.evil.com:43123/',
    'invalid',
  ])
    assert.ok(!isAppPageRequest(url, 43123), url);
  assert.ok(isAppPageRequest('http://localhost/', 80));
});

test('the report counts actions done apart from checks passed', () => {
  const text = describe('http://localhost:5173/', {
    title: '扫雷',
    steps: [
      { step: '点击“开始游戏”', ok: true, check: false },
      { step: '检查页面有“游戏开始”', ok: true, check: true },
      { step: '检查页面有“计时器”', ok: false, detail: '页面上没有这段文字', check: true },
    ],
    screenshots: ['C:\\data\\page-tests\\a-final.png'],
    consoleErrors: ['Uncaught TypeError: x is undefined'],
  });
  assert.match(text, /操作完成 1\/1；检查通过 1\/2。/);
  assert.match(text, /✗ 检查页面有“计时器” —— 页面上没有这段文字/);
  assert.match(text, /截图：C:\\data\\page-tests\\a-final\.png/);
  assert.match(text, /页面控制台报错（1）/);
  // Without checks, finishing the steps proves nothing about the page.
  assert.match(
    describe('http://localhost/', {
      title: '',
      steps: [{ step: '点击“x”', ok: true, check: false }],
      screenshots: [],
      consoleErrors: [],
    }),
    /这次没有检查项/,
  );
});
