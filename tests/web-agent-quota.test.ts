import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import {
  detectWebLimit,
  parseWebReset,
  parseWebUsage,
  webUsageSnapshot,
} from '../src/server/external-agents/config.ts';
import { activeWebCooldown, webQuotaLabel, type ExternalAgentView } from '../src/shared/external-agents.ts';
import { webQuotaLines, quotaTotals } from '../src/shared/quota-summary.ts';
import { lineExecutor } from '../src/server/node/node-runtimes.ts';
import { trayPopupHtml } from '../src/electron/tray-popup.ts';
import { WebAgentQuotaRows } from '../src/ui/ExternalAgents.tsx';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import type { WebAgentRequest, WebAgentResult } from '../src/shared/web-bridge.ts';
import { inMemorySource } from './helpers/in-memory-source.ts';

const now = Date.parse('2026-10-11T08:00:00Z');
const agent: ExternalAgentView = {
  id: 'muse',
  name: 'Muse',
  kind: 'web',
  description: '',
  enabled: true,
  available: true,
  usageUrl: 'https://fixture.test/usage',
};

test('web peer plans use reported subscriptions, never cooldown or default window names', () => {
  for (const label of ['额度', '每周额度', '未报告套餐', 'Muse Pro', 'Free plan']) {
    for (const limited of [false, true]) {
      const reading: ExternalAgentView = {
        ...agent,
        cooldown: limited ? detectWebLimit('已达上限，3小时后重置', true, now) : undefined,
        quota: {
          status: 'known',
          source: 'fixture',
          observedAt: new Date(now).toISOString(),
          windows: [{ id: 'muse-weekly', label, usedPercent: 25, resetsAt: null }],
        },
      };
      const expected = label === 'Muse Pro' ? label : label === 'Free plan' ? '免费版' : undefined;
      const line = webQuotaLines([reading], now)[0]!;
      assert.equal(line.plan, expected);
      assert.equal(lineExecutor(line)!.plan, expected);
      assert.equal(lineExecutor(line)!.windows[0]!.name, '额度');
      assert.equal(lineExecutor({ ...line, plan: undefined })!.plan, undefined, 'old tray windows never become plans');
      reading.quota!.subscription = {
        label: 'Reported Pro',
        source: 'fixture',
        observedAt: new Date(now).toISOString(),
      };
      assert.equal(lineExecutor(webQuotaLines([reading], now)[0])!.plan, 'Reported Pro');
    }
  }
  const cooldownOnly = webQuotaLines(
    [{ ...agent, cooldown: detectWebLimit('已达上限，3小时后重置', true, now) }],
    now,
  )[0]!;
  assert.equal(lineExecutor(cooldownOnly)!.plan, undefined);
});

test('Muse stale unlearned readings expose refresh and the settings hint in both layouts', () => {
  for (const compact of [false, true])
    for (const stale of [false, true])
      for (const learned of [false, true]) {
        const html = renderToStaticMarkup(
          createElement(WebAgentQuotaRows, {
            agents: [
              {
                ...agent,
                usageUrl: learned ? agent.usageUrl : undefined,
                quota: {
                  status: 'known',
                  observedAt: new Date(now - 60_000).toISOString(),
                  source: 'fixture',
                  windows: [
                    {
                      id: 'muse-weekly',
                      label: '每周额度',
                      usedPercent: 20,
                      resetsAt: new Date(now + (stale ? -1 : 60_000)).toISOString(),
                    },
                  ],
                },
              },
            ],
            now,
            compact,
            onRead() {},
          }),
        );
        assert.equal(html.includes('aria-label="Muse 读取用量"'), stale && !learned);
        assert.equal(html.includes('在 Muse 窗口打开 设置 → 通用 → 使用情况 即可刷新'), stale && !learned);
        assert.match(html, /80/);
      }
});

test('site limit fixtures: English and Chinese with relative and absolute reset times', () => {
  for (const [text, reset] of [
    ["You've reached your limit. Try again in 3 hours", '2026-10-11T11:00:00.000Z'],
    ['Usage limit reached. Resets on 2026-10-18T08:00:00Z', '2026-10-18T08:00:00.000Z'],
    ['已达上限，3小时后重置', '2026-10-11T11:00:00.000Z'],
    ['额度已用完，重置时间：2026年10月18日 08:00 UTC', '2026-10-18T08:00:00.000Z'],
    ['Token limit exceeded. Resets on October 18, 2026 at 08:00 UTC', '2026-10-18T08:00:00.000Z'],
    ['Usage limit reached. Resets at 11:30 UTC', '2026-10-11T11:30:00.000Z'],
    ['已达上限，1小时30分钟后重置', '2026-10-11T09:30:00.000Z'],
  ]) {
    const result = detectWebLimit(text!, true, now)!;
    assert.equal(result.resetsAt, reset, text);
    assert.equal(result.observedAt, new Date(now).toISOString());
    assert.equal(result.reason, text);
  }
  assert.equal(detectWebLimit('已达上限', true, now)?.resetsAt, null);
  assert.equal(parseWebReset('Reset date unknown', now), null);
});

test('reply text and explanations cannot create a cooldown', () => {
  for (const text of ["You've reached your limit. Try again in 3 hours", '额度已用完，3小时后重置', 'usage limit'])
    assert.equal(detectWebLimit(text, false, now), undefined);
  for (const text of [
    'If you see "usage limit", wait.',
    'This explains usage limits.',
    'Usage limit is 500 tokens',
    'Usage limit: 500',
    'Weekly limit resets on October 14',
    'Used 87%. Weekly limit resets on October 14',
    '每周限额将在 10月14日重置',
    '例如：已达上限',
    '尚未达到上限',
    'Welcome',
  ])
    assert.equal(detectWebLimit(text, true, now), undefined);
  assert.equal(activeWebCooldown(detectWebLimit('已达上限，3小时后重置', true, now), now + 3 * 3_600_000), undefined);
  assert.ok(activeWebCooldown(detectWebLimit('已达上限', true, now), now + 7 * 86_400_000));
});

test('usage page fixtures: used/left percentages, Muse tokens, reset date and unknown shape', () => {
  for (const [text, used] of [
    ['Used 25%. Resets on 2026-10-18T08:00:00Z', 25],
    ['25% used', 25],
    ['75% remaining', 25],
    ['剩余：75%', 25],
    ['已使用 25%', 25],
    ['Muse tokens: 1,000 of 4,000', 25],
    ['1,000 / 4,000 Muse tokens', 25],
    ['令牌已用：1000 / 4000', 25],
  ] as const) {
    const quota = parseWebUsage(text, now);
    assert.equal(quota.status, 'known', text);
    assert.equal(quota.source, '网页用量页');
    assert.equal(quota.observedAt, '2026-10-11T08:00:00.000Z');
    assert.equal(quota.windows[0]!.usedPercent, used);
    assert.equal(quota.windows[0]!.observedAt, quota.observedAt);
    assert.equal(quota.windows[0]!.id, 'web-usage');
  }
  assert.equal(
    parseWebUsage('Used 25%. Resets on 2026-10-18T08:00:00Z', now).windows[0]!.resetsAt,
    '2026-10-18T08:00:00.000Z',
  );
  for (const text of ['Welcome', '', 'Plan price 25%', 'Used 130%', 'Muse tokens 1 of 0', 'Remaining 105%']) {
    assert.equal(parseWebUsage(text, now).status, 'unknown');
    assert.deepEqual(parseWebUsage(text, now).windows, []);
  }
});

test('usage tab and tray render readings, cooldown countdown and unknown without a fake bar', () => {
  const known = { ...agent, quota: parseWebUsage('Used 25%. Resets on 2026-10-18T08:00:00Z', now) };
  const limited = {
    ...agent,
    id: 'muse' as const,
    name: 'Muse',
    cooldown: detectWebLimit('已达上限，3小时后重置', true, now),
  };
  const unknown = { ...agent, id: 'muse' as const, name: 'Muse', quota: parseWebUsage('Welcome', now) };
  const markup = (agents: ExternalAgentView[]) =>
    renderToStaticMarkup(createElement(WebAgentQuotaRows, { agents, now }));
  assert.match(markup([known, limited]), /外部智能体/);
  assert.match(markup([known]), /aria-valuenow="75"/);
  const limitedMarkup = markup([limited]);
  assert.match(limitedMarkup, /aria-valuenow="0"/);
  // The subscription-card row wraps the remaining label separately from its percentage.
  assert.match(limitedMarkup.replace(/<[^>]*>/g, ''), /剩余 0%.*3 小时 0 分钟后重置/);
  const knownMarkup = markup([known]);
  assert.match(knownMarkup, /class="quota-window-heading"/);
  assert.doesNotMatch(knownMarkup, /更新于/);
  assert.match(knownMarkup, /title="每 10 分钟自动刷新用量页面"/);
  assert.doesNotMatch(knownMarkup.replace(/<[^>]*>/g, ''), /每 10 分钟自动刷新/);
  assert.match(markup([unknown]), /没读到用量/);
  assert.equal(markup([{ ...known, added: false }]), '', 'unadded bots have no usage card');
  assert.match(markup([{ ...known, added: true, enabled: false }]), /Muse/, 'configured disabled bots stay visible');
  assert.deepEqual(webQuotaLines([{ ...known, added: false }], now), [], 'unadded bots have no tray reading');
  assert.match(markup([unknown]), /https:\/\/fixture.test\/usage/);
  assert.doesNotMatch(markup([unknown]), /progressbar/);
  const lines = webQuotaLines([known, limited, unknown, { ...known, enabled: false }], now);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => line.bars),
    [[75], [0]],
  );
  assert.deepEqual(quotaTotals(lines), [], 'web agents never join CLI account totals');
  const tray = trayPopupHtml({ running: 0, lines, totals: [] }, now);
  assert.match(tray, /Muse/);
  assert.match(tray, /width:75%/);
  assert.match(tray, /已用完 · 3 小时 0 分钟后重置/);
  assert.equal(webQuotaLines([limited], now + 3 * 3_600_000).length, 0);
  assert.match(webQuotaLabel(known, now + 7 * 86_400_000), /上次读数.*剩余 75%/);
});

test('usage settings save the optional URL and invoke the read action using a fixture API', async () => {
  const code = await uiBundle(resolve('src/ui/ExternalAgents.tsx'));
  const calls: { path: string; body: unknown }[] = [];
  const saved = { ...agent };
  const props = {
    api: async (path: string, body: any) => {
      calls.push({ path, body });
      if (body?.usageUrl !== undefined) saved.usageUrl = body.usageUrl;
      return { agents: [saved], ok: true, message: '已读取用量。' };
    },
    notify() {},
  };
  const harness = uiHarness(code);
  harness.render('ExternalAgentsCard', props);
  await nextTurn();
  let tree = harness.render('ExternalAgentsCard', props);
  let input = findNode(tree, (node) => node.props['aria-label'] === 'Muse 用量页面')!;
  input.props.onChange({ target: { value: 'https://fixture.test/settings/usage' } });
  tree = harness.render('ExternalAgentsCard', props);
  input = findNode(tree, (node) => node.props['aria-label'] === 'Muse 用量页面')!;
  input.props.onBlur();
  await nextTurn();
  tree = harness.render('ExternalAgentsCard', props);
  assert.ok(
    calls.some((call) => call.path === '/api/external-agents/muse' && (call.body as any)?.usageUrl === saved.usageUrl),
  );
  const button = findNode(tree, (node) => node.type === 'button' && node.props.children === '读取用量')!;
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  await nextTurn();
  assert.ok(calls.some((call) => call.path === '/api/external-agents/muse/usage'));
  harness.unmount();
});

test('isolated visible-page snapshot excludes chat, fields and hidden content, while retaining site notices', () => {
  const el = (text: string, excluded = false, visible = true) => ({
    innerText: text,
    getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: 20 }),
    closest: () => (excluded ? {} : null),
    querySelector: () => null,
  });
  const notice = el('已达上限，3小时后重置');
  const reply = el('Usage limit reached', true);
  const nodes = [el('Used 25%'), reply, el('password', true), el('Remaining 100%', false, false)].map(
    (parentElement) => ({ parentElement, textContent: parentElement.innerText }),
  );
  const result = runInNewContext(webUsageSnapshot(), {
    document: {
      body: {},
      querySelectorAll: () => [notice, reply],
      createTreeWalker: () => ({ nextNode: () => nodes.shift() }),
    },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    location: { href: 'https://fixture.test/usage' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.notices)), ['已达上限，3小时后重置']);
  assert.equal(result.text, 'Used 25%');
});

test('saved reply selectors keep a custom reply error region out of limit detection', () => {
  const reply = {
    innerText: "You've reached your limit",
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    closest: (selector: string) => (selector === '.answer' ? {} : null),
    querySelector: () => null,
  };
  const page = runInNewContext(webUsageSnapshot('.answer', false), {
    document: { querySelectorAll: () => [reply] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    location: { href: 'https://fixture.test/chat' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(page.notices)), []);
});

test('DOM usage blocks group separate plan, subtitle and percentage elements without other page text', () => {
  const body = {};
  const element = (innerText: string, parentElement: unknown = body) => ({
    innerText,
    parentElement,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    closest: () => null,
    querySelector: () => null,
  });
  const weekly = element('免费版\n每周限额将在 10月14日重置\n已使用 87%');
  const extra = element('额外的使用额度\n已使用 0%（剩余 259 亿个词元）\n从不过期');
  const nodes = [
    element('PRIVATE_PROFILE private@example.test'),
    element('免费版', weekly),
    element('每周限额将在 10月14日重置', weekly),
    element('已使用 87%', weekly),
    element('额外的使用额度', extra),
    element('已使用 0%（剩余 259 亿个词元）', extra),
    element('从不过期', extra),
  ].map((parentElement) => ({ parentElement, textContent: parentElement.innerText }));
  const result = runInNewContext(webUsageSnapshot(), {
    document: { body, querySelectorAll: () => [], createTreeWalker: () => ({ nextNode: () => nodes.shift() }) },
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    location: { href: 'https://fixture.test/settings/usage' },
  });
  assert.deepEqual(Array.from(result.usageBlocks), [weekly.innerText, extra.innerText]);
  assert.doesNotMatch(result.usageBlocks.join(' '), /PRIVATE_PROFILE|private@example/);
  const quota = parseWebUsage(result.usageBlocks.join('\n'), now, true);
  assert.equal(quota.windows[0]!.usedPercent, 87);
  assert.equal(quota.balances![0]!.remainingTokens, 25.9e9);
});

test('usage group reads the selected web agent and refreshes its visible result with the existing API', async () => {
  const code = await uiBundle('src/ui/ExternalAgents.tsx');
  const calls: string[] = [];
  const props = {
    now,
    api: async (path: string) => {
      calls.push(path);
      return { agents: [{ ...agent, quota: parseWebUsage('Used 25%', now) }], message: '已读取用量。' };
    },
  };
  const harness = uiHarness(code);
  harness.render('WebAgentQuotas', props);
  await nextTurn();
  const tree = harness.render('WebAgentQuotas', props);
  const rows = findNode(tree, (node) => node.props.onRead)!;
  rows.props.onRead(agent);
  await nextTurn();
  const updated = harness.render('WebAgentQuotas', props);
  assert.equal(calls.at(-1), '/api/external-agents/muse/usage');
  assert.equal(findNode(updated, (node) => node.props.onRead)!.props.agents[0].quota.windows[0].usedPercent, 25);
  harness.unmount();
});

// Bundle just this module in memory with Electron replaced; no browser or app process starts.
async function bridgeFixture() {
  const built = await build({
    entryPoints: [resolve('src/electron/web-bridge.ts')],
    plugins: [inMemorySource],
    tsconfigRaw: {},
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
  });
  const windows: FakeWindow[] = [];
  const copied: string[] = [];
  const opened: string[] = [];
  let check = '';
  let notices: string[] = [];
  let lateNotice = false;
  class FakeWindow {
    url = '';
    loads: string[] = [];
    typed: string[] = [];
    sends = 0;
    constructor(readonly options: any) {
      windows.push(this);
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return true;
    }
    on() {}
    async loadURL(url: string) {
      this.url = url;
      this.loads.push(url);
    }
    webContents = {
      getURL: () => this.url,
      isLoading: () => false,
      session: {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest() {} },
      },
      setWindowOpenHandler() {},
      on() {},
      focus() {},
      sendInputEvent: (event: { type: string; x?: number }) => {
        if (event.type === 'mouseUp' && event.x === 2) {
          this.sends++;
          if (lateNotice) notices = ['已达上限，3小时后重置'];
        }
      },
      insertText: (text: string) => this.typed.push(text),
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        const code = scripts[0]!.code;
        if (code.endsWith('__pugportBridge.find({})') || /__pugportBridge.find\(/.test(code.slice(-150)))
          return { check, loginHint: check === 'login', input: !check, send: true, reply: false, selectors: {} };
        const operation = code.slice(code.lastIndexOf(';\n') + 2);
        if (operation === '__pugportBridge.prepare()') return { x: 1, y: 1 };
        if (operation === '__pugportBridge.value()') return this.typed.join('');
        if (operation.startsWith('__pugportBridge.sendTarget(')) return { x: 2, y: 1, disabled: false };
        if (operation.startsWith('__pugportBridge.status('))
          return { check, tracking: true, changed: 1, generating: false, quietMs: 999999, inputText: '' };
        if (operation.startsWith('__pugportBridge.reply('))
          return { text: "Ordinary reply: You've reached your limit means you should wait.", selector: '.answer' };
        return { notices, text: 'Fixture plan 25% Resets in 3 days', url: this.url };
      },
    };
  }
  const module = { exports: {} as any };
  const require = createRequire(import.meta.url);
  runInNewContext(built.outputFiles[0]!.text, {
    __filename: resolve('src/electron/web-bridge.ts'),
    module,
    exports: module.exports,
    require: (name: string) =>
      name === 'electron'
        ? {
            BrowserWindow: FakeWindow,
            clipboard: { writeText: (text: string) => copied.push(text) },
            shell: {
              openExternal: async (url: string) => {
                opened.push(url);
              },
            },
          }
        : require(name),
    URL,
    process,
    setTimeout: (fn: () => void, ms: number) => {
      if (ms < 1000) queueMicrotask(fn);
      return 1;
    },
    clearTimeout() {},
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
  });
  const bridge = new module.exports.WebBridge({ port: 54321, present() {} }) as {
    handle(request: WebAgentRequest): Promise<WebAgentResult>;
  };
  return {
    bridge,
    windows,
    copied,
    opened,
    check: (value: string) => {
      check = value;
    },
    notices: (value: string[]) => {
      notices = value;
    },
    lateNotice: () => {
      lateNotice = true;
    },
  };
}

test('Grok desktop IPC copies and opens links without constructing, typing in or reading any web window', async () => {
  const f = await bridgeFixture();
  const target = { agentId: 'grok-bot', name: 'Grok Bot', url: 'grokbot://app/v1/agent?id=bot-123' };
  assert.equal((await f.bridge.handle({ ...target, action: 'desktop-handoff', text: 'my part' })).ok, true);
  assert.deepEqual(f.copied, ['my part']);
  assert.deepEqual(f.opened, [target.url]);
  assert.equal((await f.bridge.handle({ ...target, action: 'send', text: 'no automation' })).ok, false);
  assert.equal((await f.bridge.handle({ ...target, action: 'open', url: 'https://x.ai/bot' })).ok, false);
  assert.equal(f.windows.length, 0);
});

test('desktop bridge opens a configured usage URL in the existing partition and skips human checks', async () => {
  const f = await bridgeFixture();
  const target = { agentId: 'muse', name: 'Muse', url: 'https://fixture.test/chat' };
  assert.equal((await f.bridge.handle({ ...target, action: 'usage', automatic: true })).ok, false);
  assert.equal(f.windows.length, 0, 'automatic reads do not create a fresh login window');
  await f.bridge.handle({ ...target, action: 'open' });
  const window = f.windows[0]!;
  const quota = await f.bridge.handle({
    ...target,
    action: 'usage',
    url: 'https://fixture.test/settings/usage',
    navigate: true,
  });
  assert.equal(quota.quota?.windows[0]?.usedPercent, 25);
  assert.equal(f.windows.length, 1);
  assert.equal(window.options.webPreferences.partition, 'persist:pugport-web-muse');
  assert.deepEqual(window.loads, ['https://fixture.test/chat', 'https://fixture.test/settings/usage']);
  for (const check of ['human-check', 'login']) {
    f.check(check);
    const result = await f.bridge.handle({
      ...target,
      action: 'usage',
      url: 'https://fixture.test/settings/usage',
      navigate: true,
    });
    assert.equal(result.code, check);
    assert.equal(window.loads.length, 2, 'no usage navigation while a human check or login shows');
  }
});

test('without a usage URL, read usage presents the existing window and explains where to open the menu', async () => {
  const f = await bridgeFixture();
  const target = { agentId: 'muse', name: 'Muse', url: 'https://fixture.test/chat' };
  await f.bridge.handle({ ...target, action: 'open' });
  f.windows[0]!.url = 'https://redirect.fixture.test/settings';
  const result = await f.bridge.handle({ ...target, action: 'usage', navigate: false });
  assert.equal(result.message, '在这个窗口里打开用量（Muse：设置 → 通用 → 使用情况），PugPort 会自动记下');
  assert.deepEqual(f.windows[0]!.loads, ['https://fixture.test/chat']);
  assert.equal(
    f.windows[0]!.url,
    'https://redirect.fixture.test/settings',
    'an existing redirected window is not navigated away',
  );
  assert.deepEqual(f.windows[0]!.typed, []);
});

test('desktop limit banner is detected before typing', async () => {
  const f = await bridgeFixture();
  const target = { agentId: 'muse', name: 'Muse', url: 'https://fixture.test/chat' };
  f.notices(['已达上限，3小时后重置']);
  const result = await f.bridge.handle({ ...target, action: 'send', text: '你好' });
  assert.ok(result.limit);
  assert.deepEqual(f.windows[0]!.typed, []);
});

test('desktop catches a limit after sending without replaying, while ordinary replies mentioning limits succeed', async () => {
  const target = { agentId: 'muse', name: 'Muse', url: 'https://fixture.test/chat' };
  const limited = await bridgeFixture();
  limited.lateNotice();
  const stopped = await limited.bridge.handle({ ...target, action: 'send', text: '你好' });
  assert.ok(stopped.limit);
  assert.equal(limited.windows[0]!.sends, 1);
  assert.deepEqual(limited.windows[0]!.typed, ['你好']);
  const ordinary = await bridgeFixture();
  const result = await ordinary.bridge.handle({ ...target, action: 'send', text: '解释额度' });
  assert.equal(result.ok, true);
  assert.match(result.reply!, /You've reached your limit/);
  assert.equal(result.limit, undefined);
});
