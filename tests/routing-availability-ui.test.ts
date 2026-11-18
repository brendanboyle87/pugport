import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { routePolicy } from '../src/shared/route-policy.ts';
import { RoutePolicyEditor, routeOptions } from '../src/ui/RoutePolicyEditor.tsx';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

test('preference platforms come from enabled connected CLIs and API accounts', () => {
  const targets = [
    { id: 'native-claude', provider: 'claude', enabled: true, environment: 'native' },
    { id: 'missing-gemini', provider: 'gemini', enabled: true, environment: 'native' },
    {
      id: 'api-deepseek',
      provider: 'pi',
      gateway: 'api',
      apiProvider: 'deepseek',
      enabled: true,
      environment: 'native',
    },
    { id: 'disabled', provider: 'grok', enabled: false, environment: 'native' },
    { id: 'auth', provider: 'grok', enabled: true, environment: 'native' },
    { id: 'error', provider: 'cursor', enabled: true, environment: 'native' },
    { id: 'wsl', provider: 'codex', enabled: true, environment: 'wsl' },
    { id: 'internal', provider: 'pi', enabled: true, environment: 'native' },
  ] as RuntimeTarget[];
  const runtimes = targets.map((target) => ({
    ...target,
    installed: target.id !== 'missing-gemini',
    status:
      target.id === 'missing-gemini'
        ? 'missing'
        : target.id === 'auth'
          ? 'auth-required'
          : target.id === 'error'
            ? 'error'
            : 'ready',
    models: [],
    quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: '2026-10-25T12:00:00Z',
  })) as RuntimeSnapshot[];
  assert.deepEqual(routeOptions(targets, runtimes), [
    { key: 'claude', label: 'Claude' },
    { key: 'api:deepseek', label: 'DeepSeek API' },
  ]);
});

test('changing an available preference never discards a saved disconnected platform', async () => {
  const h = uiHarness(await uiBundle('src/ui/RoutePolicyEditor.tsx'));
  const old = routePolicy({ designProvider: 'gemini', architectureProvider: 'codex', routePolicy: {} });
  let next: typeof old | undefined;
  const tree = h.render('RoutePolicyEditor', {
    value: old,
    options: [{ key: 'claude', label: 'Claude' }],
    onChange: (value: typeof old) => (next = value),
  });
  findNode(tree, (node) => node.props['aria-label'] === '界面 / 前端设计 使用 Claude')!.props.onClick();
  assert.deepEqual([...next!.design], ['gemini', 'claude']);
  findNode(tree, (node) => node.props['aria-label'] === '界面 / 前端设计 移除不可用的 Gemini')!.props.onClick();
  assert.deepEqual([...next!.design], []);
  h.unmount();
});

test('a disconnected rule target remains visible while new candidates only list connected providers', async () => {
  const h = uiHarness(await uiBundle('src/ui/RoutingRulesEditor.tsx'));
  const tree = h.render('RoutingCandidateEditor', {
    value: { provider: 'gemini' },
    cards: [{ id: 'api-deepseek', label: 'DeepSeek', provider: 'pi' }],
    label: '候选',
    onChange() {},
  });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /Gemini · 不可用/);
  assert.match(serialized, /DeepSeek/);
  assert.doesNotMatch(serialized, /p:claude|p:grok|p:codex|p:cursor|p:dsh/);
  assert.match(
    renderToStaticMarkup(
      createElement(RoutePolicyEditor, {
        value: routePolicy({ designProvider: 'gemini', architectureProvider: 'codex' }),
        options: [],
        onChange() {},
      }),
    ),
    /不可用/,
  );
  h.unmount();
});
