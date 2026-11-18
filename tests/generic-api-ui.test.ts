import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState } from '../src/shared/types.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/Executors.tsx').then((code) => `${code}\nmodule.exports.ApiRow = ApiRow;`);

async function fixture(platform: NodeJS.Platform = 'win32') {
  const harness = uiHarness(await bundle, { Error });
  const calls: Array<{ path: string; body: any }> = [];
  const notices: Array<{ message: string }> = [];
  let closed = false;
  let finish: (() => void) | undefined;
  let pending = false;
  const props = {
    state: { app: { platform }, settings: {}, targets: [], runtimes: [] } as unknown as AppState,
    initialKind: 'api',
    api: async (path: string, body: unknown) => {
      calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
      if (pending)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return {};
    },
    reload: async () => {},
    notify: (notice: { message: string }) => notices.push(notice),
    onClose: () => {
      closed = true;
    },
  };
  const tree = () => harness.render('AddDialog', props);
  const change = (label: string, value: string) =>
    findNode(tree(), (node) => node.props['aria-label'] === label)!.props.onChange({ target: { value } });
  const key = () => findNode(tree(), (node) => node.type === 'input' && node.props.type === 'password')!;
  const submit = () => findNode(tree(), (node) => node.props.className === 'button primary')!.props.onClick();
  findNode(tree(), (node) => node.props.role === 'radio' && text(node) === '自定义 API')!.props.onClick();
  key().props.onChange({ target: { value: 'synthetic-key-not-a-secret' } });
  change('Endpoint', 'https://synthetic.openai.azure.com/openai/v1/responses');
  change('部署名称', 'synthetic-deployment');
  return {
    harness,
    props,
    calls,
    notices,
    tree,
    change,
    key,
    submit,
    budget() {
      findNode(tree(), (node) => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({
        target: { checked: true },
      });
    },
    defer() {
      pending = true;
    },
    finish() {
      finish!();
    },
    get closed() {
      return closed;
    },
  };
}

test('generic API adds a normalized Azure deployment and an optional USD budget with existing defaults', async () => {
  const f = await fixture();
  assert.equal(findNode(f.tree(), (node) => node.type === 'select')!.props.value, 'azure-openai-responses');
  assert.equal(f.key().props.type, 'password');
  assert.equal(
    findNode(f.tree(), (node) => node.type === 'a' && !node.props.href),
    undefined,
  );
  assert.doesNotMatch(text(f.tree()), /synthetic-key-not-a-secret/);
  f.change('输入（USD / 100 万 tokens）', '2');
  f.change('输出（USD / 100 万 tokens）', '8');
  f.budget();
  f.change('额度（美元）', '25');
  f.change('到期日（可留空）', '2027-01-02');
  assert.equal(findNode(f.tree(), (node) => node.props['aria-label'] === '每次任务预留（美元）')!.props.value, '1');
  f.submit();
  await nextTurn();
  assert.deepEqual(f.calls, [
    {
      path: '/api/api-providers',
      body: {
        preset: 'custom-api',
        key: 'synthetic-key-not-a-secret',
        connection: {
          protocol: 'azure-openai-responses',
          baseUrl: 'https://synthetic.openai.azure.com/openai/v1',
          model: 'synthetic-deployment',
          price: { input: 2, output: 8 },
        },
        budget: {
          limitUsd: 25,
          expiresAt: new Date('2027-01-02T00:00').toISOString(),
          perRunUsd: 1,
          maxConcurrentRuns: 1,
          burstConcurrentRuns: 4,
          preferExpiring: true,
        },
      },
    },
  ]);
  assert.equal(f.closed, true);
  f.harness.unmount();
});

test('generic API validation blocks credential URLs, missing models, partial prices and invalid budgets before a write', async () => {
  const f = await fixture();
  for (const value of [
    'https://user:password@example.test/openai/v1',
    'https://example.test/openai/v1?api-key=synthetic',
  ]) {
    f.change('Endpoint', value);
    f.submit();
    await nextTurn();
    assert.equal(f.calls.length, 0);
    assert.ok(findNode(f.tree(), (node) => node.props.role === 'alert'));
  }
  f.change('Endpoint', 'https://synthetic.openai.azure.com/openai/v1/responses');
  f.change('部署名称', '');
  f.submit();
  await nextTurn();
  assert.equal(f.calls.length, 0);
  f.change('部署名称', 'synthetic-deployment');
  f.change('输入（USD / 100 万 tokens）', '2');
  f.submit();
  await nextTurn();
  assert.equal(f.calls.length, 0, 'both prices are required together');
  f.change('输入（USD / 100 万 tokens）', '');
  f.budget();
  f.submit();
  await nextTurn();
  assert.equal(f.calls.length, 0, 'budgets require explicit prices');
  f.change('输入（USD / 100 万 tokens）', '2');
  f.change('输出（USD / 100 万 tokens）', '8');
  f.change('额度（美元）', '0.5');
  f.submit();
  await nextTurn();
  assert.equal(f.calls.length, 0, 'reserve cannot exceed the budget');
  f.change('额度（美元）', '20');
  f.change('每次任务预留（美元）', '0');
  f.submit();
  await nextTurn();
  assert.equal(f.calls.length, 0);
  assert.equal(f.closed, false);
  f.harness.unmount();
});

test('context and output limits are offered and submitted on macOS only', async () => {
  const label = (node: { props: Record<string, unknown> }) => node.props['aria-label'] === '上下文长度（tokens）';
  for (const platform of ['win32', 'linux'] as const) {
    const other = await fixture(platform);
    assert.equal(findNode(other.tree(), label), undefined, `${platform} keeps the fixed limits`);
    other.harness.unmount();
  }
  const f = await fixture('darwin');
  f.change('协议', 'openai-completions');
  f.change('Endpoint', 'http://127.0.0.1:8000/v1');
  f.change('模型 ID', 'synthetic-local-model');
  f.change('上下文长度（tokens）', '8192');
  f.change('单次输出上限（tokens）', '16384');
  await f.submit();
  await nextTurn();
  assert.equal(f.calls.length, 0, 'an output limit above the context never reaches the server');
  f.change('上下文长度（tokens）', '65536');
  f.change('单次输出上限（tokens）', '32768');
  await f.submit();
  await nextTurn();
  assert.deepEqual(f.calls[0]!.body.connection, {
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'synthetic-local-model',
    limits: { contextWindow: 65536, maxTokens: 32768 },
  });
  f.harness.unmount();
});

test('unpriced API connection remains usable and repeated submissions serialize while controls are blocked', async () => {
  const f = await fixture();
  f.change('协议', 'openai-completions');
  f.change('Endpoint', 'https://synthetic.example.test/v1/chat/completions');
  f.change('模型 ID', 'synthetic-model');
  f.defer();
  const stale = findNode(f.tree(), (node) => node.props.className === 'button primary')!;
  stale.props.onClick();
  stale.props.onClick();
  assert.equal(f.calls.length, 1);
  assert.equal(findNode(f.tree(), (node) => node.type === 'fieldset')!.props.disabled, true);
  assert.deepEqual(f.calls[0]!.body.connection, {
    protocol: 'openai-completions',
    baseUrl: 'https://synthetic.example.test/v1',
    model: 'synthetic-model',
  });
  assert.equal(f.calls[0]!.body.budget, undefined);
  f.finish();
  await nextTurn();
  assert.equal(f.closed, true);
  f.harness.unmount();
});

test('unpriced API account shows unknown cost and its connection without empty console links', async () => {
  const harness = uiHarness(await bundle);
  const tree = harness.render('ApiRow', {
    provider: {
      targetId: 'synthetic',
      preset: 'custom-api',
      label: 'Synthetic API',
      enabled: true,
      console: '',
      currency: 'USD',
      keyHint: '…fixture',
      connection: {
        protocol: 'openai-responses',
        baseUrl: 'https://synthetic.example.test/v1',
        model: 'synthetic-model',
      },
    },
    target: { id: 'synthetic', provider: 'pi' },
    state: { settings: {} },
    api: async () => ({}),
    reload: async () => {},
    notify() {},
  });
  assert.match(text(tree.props.metric), /费用未知/);
  assert.match(text(tree), /费用未知/);
  assert.match(text(tree), /https:\/\/synthetic.example.test\/v1/);
  assert.match(text(tree), /synthetic-model/);
  assert.equal(
    findNode(tree, (node) => node.type === 'a' && !node.props.href),
    undefined,
  );
  harness.unmount();
});

test('invalid saved connection remains readable with an error and an available removal control', async () => {
  const harness = uiHarness(await bundle);
  const tree = harness.render('ApiRow', {
    provider: {
      targetId: 'synthetic-invalid',
      preset: 'custom-api',
      label: 'Synthetic invalid API',
      enabled: false,
      console: '',
      currency: 'USD',
      connectionError: 'API 连接配置无效，请移除后重新添加。',
    },
    target: { id: 'synthetic-invalid', provider: 'pi' },
    state: { settings: {} },
    api: async () => ({}),
    reload: async () => {},
    notify() {},
  });
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /API 连接配置无效/);
  assert.match(text(tree.props.metric), /费用未知/);
  assert.equal(findNode(tree, (node) => node.type === 'button' && text(node).includes('移除'))!.props.disabled, false);
  harness.unmount();
});

test('API cards use current credit spending, hide an unknown balance, and fold test and workspace controls', async () => {
  const harness = uiHarness(await bundle);
  const props = {
    provider: {
      targetId: 'synthetic',
      preset: 'anthropic',
      label: 'Synthetic API',
      enabled: true,
      currency: 'USD',
      extra: { costUsd: 2, tokens: 0 },
      budget: { spentUsd: 4.2, policy: {} },
    },
    target: { id: 'synthetic', provider: 'pi', gateway: 'api' },
    usage: { runs: 3, totalTokens: 12, estimatedCostUsd: 12.4 },
    state: { settings: {} },
    api: async () => ({}),
    reload: async () => {},
    notify() {},
  };
  let tree = harness.render('ApiRow', props);
  assert.match(text(tree.props.metric), /已用 \$4\.20/);
  assert.doesNotMatch(text(tree), /累计费用|在控制台查看|已记录费用/);
  assert.equal(
    findNode(tree, (node) => node.type === 'dt' && text(node) === '余额'),
    undefined,
  );
  const advanced = findNode(tree, (node) => node.type === 'details' && text(node).startsWith('高级'))!;
  assert.ok(advanced);
  assert.equal(advanced.props.open, undefined);
  assert.ok(findNode(advanced, (node) => node.props['aria-label'] === 'Synthetic API 工作区 ID'));
  assert.ok(findNode(advanced, (node) => node.type?.name === 'TargetEditor'));
  tree = harness.render('ApiRow', { ...props, provider: { ...props.provider, budget: undefined } });
  assert.match(text(tree.props.metric), /已用 \$14\.40/);
  harness.unmount();
});

test('form submission respects disabled API, unsupported CLI and incomplete free-source controls', async () => {
  const f = await fixture();
  const formSubmit = () => findNode(f.tree(), (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  f.key().props.onChange({ target: { value: '' } });
  formSubmit();
  await nextTurn();
  assert.equal(f.calls.length, 0);
  findNode(f.tree(), (node) => node.props.role === 'tab' && text(node) === '订阅账号')!.props.onClick();
  formSubmit();
  await nextTurn();
  assert.equal(f.calls.length, 0);
  findNode(f.tree(), (node) => node.props.role === 'tab' && text(node) === '免费')!.props.onClick();
  findNode(f.tree(), (node) => node.props.role === 'radio' && text(node) === '自定义地址')!.props.onClick();
  formSubmit();
  await nextTurn();
  assert.equal(f.calls.length, 0);
  assert.equal(f.closed, false);
  f.harness.unmount();
});
