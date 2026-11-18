import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/WebSearchSettings.tsx');
test('search settings save and clear only the independent key without a billable test', async () => {
  const calls: any[] = [];
  const notices: any[] = [];
  let fail = false;
  const view = {
    provider: 'deepseek',
    enabled: false,
    configured: true,
    keyHint: '…test',
    monthlyLimitCny: 5,
    month: '2026-10',
    usage: { requests: 3, billableRequests: 1, uncertainRequests: 1, estimatedCostCny: 0.005, reservedCny: 0.005 },
  };
  const h = uiHarness(code, {
    localStorage: {
      getItem: () => null,
      setItem() {
        throw new Error('key persisted in browser');
      },
    },
  });
  const props = {
    api: async (path: string, body: any, method: string) => {
      calls.push({ path, body: body === undefined ? undefined : structuredClone(body), method });
      if (fail) throw new Error('Synthetic server failure');
      if (body?.clearKey) view.configured = false;
      return structuredClone(view);
    },
    notify: (notice: any) => notices.push(notice),
  };
  const render = () => h.render('WebSearchSettings', props);
  const node = (check: Parameters<typeof findNode>[1]) => {
    const found = findNode(render(), check);
    assert.ok(found);
    return found;
  };
  const key = () => node((n) => n.type === 'input' && n.props.type === 'password');
  render();
  await nextTurn();
  assert.equal(
    findNode(render(), (n) => n.type === 'input' && n.props.type === 'password'),
    undefined,
  );
  assert.equal(
    findNode(render(), (n) => n.type?.name === 'SideSheet'),
    undefined,
  );
  assert.match(text(render()), /本月 3 次请求/);
  node((n) => n.type === 'button' && n.props.children === '管理').props.onClick();
  assert.equal(node((n) => n.type?.name === 'SideSheet').props.title, '联网搜索');
  assert.equal(key().props.value, '');
  assert.match(text(render()), /未确认/);
  key().props.onChange({ target: { value: 'synthetic-search-key' } });
  node((n) => n.type === 'button' && n.props.children === '保存').props.onClick();
  await nextTurn();
  assert.deepEqual(calls.at(-1), { path: '/api/web-search', body: { key: 'synthetic-search-key' }, method: 'PUT' });
  assert.equal(key().props.value, '');
  key().props.onChange({ target: { value: 'keep-on-failure' } });
  fail = true;
  node((n) => n.type === 'button' && n.props.children === '保存').props.onClick();
  await nextTurn();
  assert.equal(key().props.value, 'keep-on-failure');
  assert.match(text(render()), /Synthetic server failure/);
  fail = false;
  assert.equal(node((n) => n.type === 'input' && n.props.type === 'checkbox').props.disabled, false);
  node((n) => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  await nextTurn();
  assert.deepEqual(calls.at(-1).body, { enabled: true });
  node((n) => n.type === 'button' && n.props.children === '清除').props.onClick();
  await nextTurn();
  assert.deepEqual(calls.at(-1).body, { clearKey: true });
  assert.equal(key().props.value, '');
  assert.equal(
    findNode(render(), (n) => n.type === 'input' && n.props.type === 'checkbox'),
    undefined,
  );
  node((n) => n.type === 'input' && n.props.type === 'number').props.onChange({ target: { value: '7.5' } });
  node((n) => n.type === 'button' && n.props.children === '保存预算').props.onClick();
  await nextTurn();
  assert.deepEqual(calls.at(-1).body, { monthlyLimitCny: 7.5 });
  assert.equal(
    calls.every((call) => call.path === '/api/web-search'),
    true,
  );
  assert.equal(notices.filter((notice) => notice.tone === 'error').length, 1);
  node((n) => n.type?.name === 'SideSheet').props.onClose();
  assert.equal(
    findNode(render(), (n) => n.type === 'input' && n.props.type === 'password'),
    undefined,
  );
  node((n) => n.type === 'button' && n.props.children === '开始设置').props.onClick();
  assert.equal(key().props.value, '');
  h.unmount();
});
