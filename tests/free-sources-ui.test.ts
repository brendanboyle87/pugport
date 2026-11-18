import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FreeSourceRow } from '../src/ui/Executors.tsx';
import type { AppState } from '../src/shared/types.ts';
import type { ApiProviderView } from '../src/shared/api-providers.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const provider: ApiProviderView = {
  targetId: 'api-groq-free',
  preset: 'groq-free',
  label: 'Groq',
  enabled: true,
  console: '',
  currency: 'USD',
  tier: 'free',
  local: false,
  mayLog: true,
  detected: true,
  modelCount: 12,
};
const state = { settings: {}, targets: [], runtimes: [] } as unknown as AppState;
const props = { state, api: async () => ({}) as any, reload: async () => {}, notify: () => {} };

test('free row shows detected count, cooldown and terms badge without paid budget controls', () => {
  const render = (p: ApiProviderView) => renderToStaticMarkup(createElement(FreeSourceRow, { ...props, provider: p }));
  const html = render(provider);
  assert.match(html, /已发现 12 个模型/);
  assert.match(html, /可能被记录/);
  assert.match(html, /title="https:\/\/console.groq.com\/docs\/legal\/terms-of-use"/);
  assert.doesNotMatch(html, /预算|API Key/);
  assert.match(
    render({
      ...provider,
      cooldown: {
        reason: 'quota',
        observedAt: new Date().toISOString(),
        retryAt: new Date(Date.now() + 120000).toISOString(),
      },
    }),
    /限流中 · 约 2 分钟后恢复/,
  );
  assert.doesNotMatch(
    render({ ...provider, preset: 'ollama', label: 'Ollama', mayLog: false, local: true }),
    /可能被记录|更换密钥/,
  );
});

const bundle = uiBundle('src/ui/Executors.tsx');
test('custom free dialog defaults logging on and rejects invalid URLs before a request', async () => {
  const harness = uiHarness(await bundle);
  const writes: any[] = [],
    notices: any[] = [];
  const p = {
    ...props,
    initialKind: 'free',
    onClose: () => {},
    api: async (...args: any[]) => {
      writes.push(args);
      return {};
    },
    notify: (notice: any) => notices.push(notice),
  };
  let tree = harness.render('AddDialog', p);
  findNode(tree, (n) => n.props.role === 'radio' && n.props.children === '自定义地址')!.props.onClick();
  tree = harness.render('AddDialog', p);
  assert.equal(findNode(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')!.props.checked, true);
  findNode(tree, (n) => n.type === 'input' && n.props.placeholder === 'https://example.com/v1')!.props.onChange({
    target: { value: 'https://user:pass@example.invalid/v1' },
  });
  tree = harness.render('AddDialog', p);
  findNode(tree, (n) => n.type === 'button' && n.props.className === 'button primary')!.props.onClick();
  await nextTurn();
  assert.equal(writes.length, 0);
  assert.equal(notices.at(-1)?.tone, 'error');
  tree = harness.render('AddDialog', p);
  findNode(tree, (n) => n.type === 'input' && n.props.placeholder === 'https://example.com/v1')!.props.onChange({
    target: { value: 'http://localhost:1234/v1/' },
  });
  findNode(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')!.props.onChange({
    target: { checked: false },
  });
  tree = harness.render('AddDialog', p);
  findNode(tree, (n) => n.type === 'button' && n.props.className === 'button primary')!.props.onClick();
  await nextTurn();
  assert.equal(writes[0][0], '/api/free-sources');
  assert.equal(writes[0][1].baseUrl, 'http://localhost:1234/v1');
  assert.equal(writes[0][1].mayLog, false);
  assert.equal(writes[0][1].key, undefined);
  harness.unmount();
});
