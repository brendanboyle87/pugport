import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableCoreTargets } from '../src/ui/core-runtime.ts';
import type { AppState, RuntimeTarget } from '../src/shared/types.ts';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('saved Gemini CLI targets are unavailable under every execution policy; API targets remain usable', () => {
  const legacy: RuntimeTarget = {
    id: 'gemini-native',
    provider: 'gemini',
    label: 'Gemini',
    command: 'synthetic',
    enabled: true,
    environment: 'native',
  };
  const api: RuntimeTarget = { ...legacy, id: 'api-google', provider: 'pi', command: '' };
  for (const policy of [undefined, 'cli-first', 'cli-only', 'api-only'] as const)
    assert.ok(!availableCoreTargets([legacy, api], policy).includes(legacy));
  assert.deepEqual(availableCoreTargets([legacy, api], 'api-only'), [api]);
});

test('add dialog offers Google API keys and Gemini API privacy terms without a Gemini CLI login', async () => {
  const code = await uiBundle('src/ui/Executors.tsx');
  const props = {
    state: { targets: [], runtimes: [], settings: {} } as unknown as AppState,
    accounts: { providers: [], accounts: [] },
    api: async () => ({}),
    reload: async () => {},
    notify() {},
    refresh: async () => {},
    refreshing: false,
    onClose() {},
  };
  const cli = uiHarness(code);
  const cliTree = cli.render('AddDialog', { ...props, initialKind: 'cli' });
  assert.equal(
    findNode(cliTree, (node) => node.type === 'option' && node.props.value === 'gemini'),
    undefined,
  );
  assert.ok(findNode(cliTree, (node) => node.type === 'option' && node.props.value === 'codex'));
  cli.unmount();
  const paid = uiHarness(code);
  const apiTree = paid.render('AddDialog', { ...props, initialKind: 'api' });
  const google = findNode(apiTree, (node) => node.type === 'button' && node.key === 'google')!;
  assert.ok(google);
  google.props.onClick();
  assert.ok(
    findNode(
      paid.render('AddDialog', { ...props, initialKind: 'api' }),
      (node) => node.props.href === 'https://aistudio.google.com/apikey',
    ),
  );
  paid.unmount();
  const free = uiHarness(code);
  const freeProps = { ...props, initialKind: 'free' };
  const tree = free.render('AddDialog', freeProps);
  const select = findNode(tree, (node) => node.type === 'button' && node.key === 'gemini-free')!;
  assert.ok(select);
  select.props.onClick();
  const selected = free.render('AddDialog', freeProps);
  assert.ok(findNode(selected, (node) => node.props.href === 'https://aistudio.google.com/apikey'));
  free.unmount();
  const row = uiHarness(code);
  const source = row.render('FreeSourceRow', {
    ...props,
    provider: {
      preset: 'gemini-free',
      targetId: 'api-gemini',
      label: 'Gemini',
      mayLog: true,
      detected: true,
      modelCount: 1,
    },
  });
  assert.ok(findNode(source, (node) => node.props.href === 'https://ai.google.dev/gemini-api/terms'));
  assert.match(text(source), /可能被记录/);
  row.unmount();
});
