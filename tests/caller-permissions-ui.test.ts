import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Settings, Workflow } from '../src/shared/types.ts';
import type { ConnectTool } from '../src/ui/AgentConnect.tsx';
import { WorkflowTrace } from '../src/ui/Workspace.tsx';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/AgentConnect.tsx');
const tool = (patch: Partial<ConnectTool> = {}): ConnectTool => ({
  id: 'claude',
  name: 'Claude Code',
  detected: true,
  state: 'connected',
  method: 'command',
  configPath: 'C:/Fixture/claude.json',
  server: 'pugport',
  manual: 'fixture mcp add pugport',
  ...patch,
});
const text = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object') return text((node as UiNode).props?.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
};
const select = (tree: unknown) => findNode(tree, (node) => node.type === 'select');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('loading and failed AgentConnect lists stay in one collapsed settings row', async () => {
  const h = uiHarness(code, { Error });
  const props = {
    api: async () => {
      throw new Error('Fixture unavailable');
    },
    notify() {},
  };
  const loading = h.render('AgentConnect', props);
  assert.equal(loading.type.name, 'SettingsRow');
  assert.equal(loading.props.status, '正在加载…');
  assert.equal(loading.props.defaultExpanded, undefined);
  await nextTurn();
  const failed = h.render('AgentConnect', props);
  assert.equal(failed.type.name, 'SettingsRow');
  assert.match(text(failed.props.status), /Fixture unavailable/);
  assert.ok(findNode(failed, (node) => node.type === 'button' && text(node) === '重试'));
  h.unmount();
});

test('disabled Codex stays collapsed, explains its status and offers to turn it back on', async () => {
  const h = uiHarness(code);
  const disabled = tool({ id: 'codex', name: 'Codex', state: 'outdated', disabled: true });
  const props = { api: async () => ({ tools: [disabled], snippet: '' }), notify() {} };
  h.render('AgentConnect', props);
  await nextTurn();
  const tree = h.render('AgentConnect', props);
  assert.equal(tree.props.defaultExpanded, undefined);
  assert.equal(h.exports.connectionStatus(disabled), '在 Codex 里已关闭');
  assert.ok(findNode(tree, (node) => node.type === 'button' && text(node) === '重新打开'));
  assert.equal(select(tree), undefined);
  h.unmount();
});

test('connected caller has three permission options and saves each choice without losing other callers', async () => {
  const calls: { path: string; body: any; method?: string }[] = [];
  const changes: unknown[] = [];
  const permissions: Settings['externalCallers'] = { codex: 'read-only' };
  const h = uiHarness(code, {
    window: {
      comboRunnerDesktop: {
        pickDirectory() {},
        async changePermission(change: any) {
          changes.push(change);
          permissions[change.tool as keyof typeof permissions] = change.mode;
          return true;
        },
      },
    },
  });
  const props = {
    externalCallers: { codex: 'read-only' } as Settings['externalCallers'],
    api: async (path: string, body?: any, method?: string) => {
      calls.push({ path, body, method });
      if (path === '/api/settings') Object.assign(permissions, body.externalCallers);
      return path === '/api/external/connections'
        ? { tools: [tool()], snippet: '' }
        : { settings: { externalCallers: { ...permissions } } };
    },
    notify() {},
  };
  h.render('AgentConnect', props);
  await nextTurn();
  let tree = h.render('AgentConnect', props);
  const field = select(tree)!;
  assert.ok(field);
  assert.equal(field.props['aria-label'], 'Claude Code 的 PugPort 任务权限');
  assert.equal(field.props.value, 'inherit');
  assert.deepEqual(plain(field.props.children.map((option: UiNode) => [option.props.value, text(option)])), [
    ['inherit', '继承 Claude Code（默认）'],
    ['read-only', '总是只读'],
    ['write', '总是可写入（限其工作目录）'],
  ]);
  for (const value of ['read-only', 'write', 'inherit']) {
    select(tree)!.props.onChange({ target: { value } });
    assert.equal(select(h.render('AgentConnect', props))!.props.disabled, true);
    await nextTurn();
    tree = h.render('AgentConnect', props);
    assert.equal(select(tree)!.props.value, value);
    assert.equal(select(tree)!.props.disabled, false);
    if (value === 'write') assert.deepEqual(plain(changes.at(-1)), { kind: 'caller', tool: 'claude', mode: value });
    else
      assert.deepEqual(plain(calls.at(-1)), {
        path: '/api/settings',
        body: { externalCallers: { codex: 'read-only', claude: value } },
        method: 'PATCH',
      });
    assert.equal(permissions.codex, 'read-only');
  }
  assert.equal(changes.length, 1);
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
  assert.equal(
    calls.some((call) => call.path === '/api/state'),
    false,
  );
  h.unmount();
});

test('stored permissions and later settings updates appear in the connected tool dropdown', async () => {
  for (const id of ['claude', 'codex', 'cursor', 'grok']) {
    const h = uiHarness(code);
    const props = {
      externalCallers: { [id]: 'write' } as Settings['externalCallers'],
      api: async () => ({ tools: [tool({ id })], snippet: '' }),
      notify() {},
    };
    h.render('AgentConnect', props);
    await nextTurn();
    assert.equal(select(h.render('AgentConnect', props))!.props.value, 'write');
    props.externalCallers = { [id]: 'read-only' };
    assert.equal(select(h.render('AgentConnect', props))!.props.value, 'read-only');
    h.unmount();
  }
});

test('cancelling a caller permission change keeps the previous value and sends no settings request', async () => {
  const changes: unknown[] = [],
    writes: string[] = [];
  const h = uiHarness(code, {
    window: {
      comboRunnerDesktop: {
        pickDirectory() {},
        async changePermission(change: unknown) {
          changes.push(plain(change));
          return false;
        },
      },
    },
  });
  const props = {
    externalCallers: { claude: 'read-only' },
    notify() {},
    api: async (path: string, body?: unknown) => {
      if (body) writes.push(path);
      return { tools: [tool()], snippet: '' };
    },
  };
  h.render('AgentConnect', props);
  await nextTurn();
  select(h.render('AgentConnect', props))!.props.onChange({ target: { value: 'write' } });
  await nextTurn();
  assert.equal(select(h.render('AgentConnect', props))!.props.value, 'read-only');
  assert.deepEqual(changes, [{ kind: 'caller', tool: 'claude', mode: 'write' }]);
  assert.deepEqual(writes, []);
  h.unmount();
});

test('unconnected, outdated, undetected and unknown tools have no permission dropdown', async () => {
  for (const patch of [
    { state: 'absent' },
    { state: 'outdated' },
    { detected: false },
    { id: 'unknown' },
  ] as Partial<ConnectTool>[]) {
    const h = uiHarness(code);
    const props = { api: async () => ({ tools: [tool(patch)], snippet: '' }), notify() {} };
    h.render('AgentConnect', props);
    await nextTurn();
    assert.equal(select(h.render('AgentConnect', props)), undefined);
    h.unmount();
  }
});

test('failed permission save keeps the previous value and reports the error', async () => {
  const notices: unknown[] = [];
  const h = uiHarness(code, { Error });
  const props = {
    externalCallers: { claude: 'write' } as Settings['externalCallers'],
    api: async (path: string) => {
      if (path === '/api/settings') throw new Error('Fixture save failed');
      return { tools: [tool()], snippet: '' };
    },
    notify: (notice: unknown) => notices.push(notice),
  };
  h.render('AgentConnect', props);
  await nextTurn();
  select(h.render('AgentConnect', props))!.props.onChange({ target: { value: 'read-only' } });
  await nextTurn();
  const field = select(h.render('AgentConnect', props))!;
  assert.equal(field.props.value, 'write');
  assert.equal(field.props.disabled, false);
  assert.equal(plain(notices)[0].tone, 'error');
  assert.match(plain(notices)[0].message, /Fixture save failed/);
  h.unmount();
});

test('caller-dispatched task renders its inherited write scope in the existing muted notice', () => {
  const stamp = '2026-10-13T12:00:00Z';
  const workflow: Workflow = {
    id: 'task',
    conversationId: 'conversation',
    projectId: 'project',
    userMessageId: 'message',
    input: {
      content: 'Fixture task',
      mode: 'build',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-first',
      permissionOrigin: { source: 'caller', mode: 'workspace-write', note: 'Claude Code', scope: 'C:/Fixture/project' },
    },
    status: 'running',
    phase: 'execute',
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const state = { runs: [], targets: [], runtimes: [], workflows: [workflow], settings: {} } as unknown as AppState;
  const html = renderToStaticMarkup(
    createElement(WorkflowTrace, {
      workflow,
      state,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(
    html,
    /<div class="workflow-read-only" role="status"><p>继承自 Claude Code：可写入 · C:\/Fixture\/project<\/p><\/div>/,
  );
  assert.doesNotMatch(html, /按可写入重新执行/);
});
