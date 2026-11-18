import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { extensions } from '../src/server/extensions.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { ConnectorService } from '../src/server/connectors.ts';
import type { RunEvent } from '../src/shared/types.ts';
import type { BridgeCatalogTool } from '../src/shared/bridge-catalog.ts';

function fixture(t: TestContext, provider = 'codex') {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-deferred-'));
  const events: RunEvent[] = [];
  const abort = new AbortController();
  const state = {
    valid: true,
    write: true,
    ask: false,
    approve: true,
    deferredTools: true,
    project: { id: 'project-a', mcpServers: undefined as string[] | undefined },
    calls: [] as { name: string; args: unknown }[],
    approvals: [] as string[],
    beforeExecute: () => {},
    onApprove: () => {},
    connectorLists: 0,
  };
  const catalog: (BridgeCatalogTool & { server: string })[] = [
    {
      name: 'mcp_a__read',
      server: 'a',
      description: 'Read calendar events',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'mcp_a__write',
      server: 'a',
      description: 'Write calendar events',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
    {
      name: 'mcp_b__read',
      server: 'b',
      description: 'Read private second project',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    },
  ];
  const exposed = (write: boolean, _skills?: string[], servers?: string[]) =>
    catalog
      .filter((tool) => (write || tool.annotations?.readOnlyHint) && (!servers || servers.includes(tool.server)))
      .map(({ server: _, ...tool }) => tool);
  t.mock.method(extensions, 'bridgeTools', exposed);
  t.mock.method(
    extensions,
    'call',
    async (
      name: string,
      args: Record<string, unknown>,
      write: boolean,
      _signal?: AbortSignal,
      skills?: string[],
      servers?: string[],
      authorize?: () => void | Promise<void>,
      validate?: () => void,
    ) => {
      state.beforeExecute();
      await authorize?.();
      validate?.();
      assert.ok(exposed(write, skills, servers).some((tool) => tool.name === name));
      state.calls.push({ name, args });
      return { content: [{ type: 'text' as const, text: 'result-' + 'x'.repeat(25000) + '-end' }], isError: false };
    },
  );
  const controller = Object.assign(new EventEmitter(), {
    dataDir: directory,
    agentBridgeCaller: () =>
      state.valid
        ? {
            run: { id: 'run-a', workflowId: 'workflow-a', toolApprovalMode: state.ask ? 'ask' : 'auto' },
            target: { provider },
            delegate: false,
            child: false,
            recycle: false,
            write: state.write,
            deferredTools: state.deferredTools,
            signal: abort.signal,
          }
        : undefined,
    recordRunEvent: (_id: string, event: RunEvent) => events.push(event),
    returnExecution: () => async () => {},
    retainMutation: () => () => {},
    approve: async (_run: unknown, title: string) => {
      state.approvals.push(title);
      state.onApprove();
      return state.approve;
    },
  }) as unknown as Controller;
  const workspace = {
    store: {
      get: (kind: string) =>
        kind === 'workflow'
          ? { id: 'workflow-a', projectId: state.project.id, conversationId: 'chat-a', input: {} }
          : kind === 'project'
            ? state.project
            : undefined,
    },
    takeNotices: () => [],
  } as unknown as Workspace;
  const connectors = {
    toolsFor: async () => {
      state.connectorLists++;
      return [];
    },
  } as unknown as ConnectorService;
  const bridge = new AgentBridge(workspace, controller, 'unused', {}, connectors);
  t.after(async () => {
    await bridge.close();
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async (method: string, params?: object) => {
    const response = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method, params });
    return response as {
      status: number;
      body: { result: { tools: BridgeCatalogTool[]; content: { text: string }[]; isError?: boolean } };
    };
  };
  const call = (name: string, args: Record<string, unknown>) => request('tools/call', { name, arguments: args });
  return { state, events, catalog, request, call };
}

test('startup catalog does not enumerate connectors or include external schemas; discovery is scoped and complete', async (t) => {
  const f = fixture(t);
  f.state.project.mcpServers = ['a'];
  f.catalog[0]!.inputSchema.description = 'full-schema-' + 's'.repeat(25000) + '-end';
  const listed = await f.request('tools/list');
  assert.equal(f.state.connectorLists, 0);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'search_tools'));
  assert.ok(!listed.body.result.tools.some((tool) => tool.name.startsWith('mcp_')));
  assert.ok(!JSON.stringify(listed).includes('full-schema'));
  const search = await f.call('search_tools', { query: 'calendar', limit: 1 });
  const found = JSON.parse(search.body.result.content[0]!.text);
  assert.equal(found.total, 2);
  assert.equal(found.nextOffset, 1);
  assert.equal(found.tools[0].inputSchema.description, f.catalog[0]!.inputSchema.description);
  assert.equal(found.scope.projectId, 'project-a');
  assert.deepEqual(found.scope.serverIds, ['a']);
  const config = f.events.find((event) => event.data?.kind === 'mcp-configuration');
  assert.deepEqual((config?.data?.detail as { serverIds: string[] }).serverIds, ['a']);
  assert.equal(f.state.connectorLists, 1);
});

for (const provider of ['codex', 'claude', 'cursor', 'grok', 'gemini', 'pi'])
  test(`${provider} proxies preserve actual tool arguments, full result, and approval`, async (t) => {
    const f = fixture(t, provider);
    f.state.ask = true;
    const args = { text: 'input-' + 'i'.repeat(12000) + '-end', api_key: 'synthetic-secret' };
    const result = await f.call('call_tool', { name: 'mcp_a__write', arguments: args });
    assert.equal(result.body.result.isError, undefined);
    assert.match(result.body.result.content[0]!.text, /-end$/);
    assert.deepEqual(f.state.calls, [{ name: 'mcp_a__write', args }]);
    assert.deepEqual(f.state.approvals, ['MCP · mcp_a__write']);
    const calls = f.events.filter((event) => event.type === 'tool');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.text, 'mcp_a__write');
    assert.equal(calls[0]!.data?.dispatchedVia, 'call_tool');
    const captured = calls[0]!.data?.arguments as typeof args;
    assert.equal(captured.text, args.text);
    assert.equal(captured.api_key, '[redacted]');
    assert.match(JSON.stringify(calls[1]!.data?.result), /-end/);
    assert.equal(calls[0]!.data?.toolCallId, calls[1]!.data?.toolCallId);
  });

test('read wrapper cannot call writers, built-ins, or the proxy itself', async (t) => {
  const f = fixture(t);
  for (const name of ['mcp_a__write', 'recycle_files', 'call_tool', 'missing']) {
    const result = await f.call('call_read_only_tool', { name, arguments: {} });
    assert.equal(result.body.result.isError, true, name);
  }
  assert.equal(f.state.calls.length, 0);
  f.state.write = false;
  const listed = await f.request('tools/list');
  assert.ok(!listed.body.result.tools.some((tool) => tool.name === 'call_tool'));
  assert.equal((await f.call('call_tool', { name: 'mcp_a__write', arguments: {} })).body.result.isError, true);
});

test('manual denial, project revocation during approval, and revocation while connecting prevent execution', async (t) => {
  const f = fixture(t);
  f.state.ask = true;
  f.state.approve = false;
  const args = { name: 'mcp_a__write', arguments: {} };
  assert.equal((await f.call('call_tool', args)).body.result.isError, true);
  f.state.approve = true;
  f.state.onApprove = () => {
    f.state.project.mcpServers = [];
  };
  assert.equal((await f.call('call_tool', args)).body.result.isError, true);
  f.state.project.mcpServers = ['a'];
  f.state.onApprove = () => {};
  f.state.beforeExecute = () => {
    f.state.project.mcpServers = [];
  };
  assert.equal((await f.call('call_tool', args)).body.result.isError, true);
  assert.equal(f.state.calls.length, 0);
});

test('project selection and read-only classification are rechecked after discovery and connection', async (t) => {
  const f = fixture(t);
  f.state.project.mcpServers = ['a'];
  await f.call('search_tools', { names: ['mcp_a__read'] });
  f.state.project = { id: 'project-b', mcpServers: ['b'] };
  assert.equal((await f.call('call_read_only_tool', { name: 'mcp_a__read', arguments: {} })).body.result.isError, true);
  const found = JSON.parse((await f.call('search_tools', {})).body.result.content[0]!.text);
  assert.deepEqual(
    found.tools.map((tool: BridgeCatalogTool) => tool.name),
    ['mcp_b__read'],
  );
  f.state.beforeExecute = () => {
    f.catalog[2]!.annotations = {};
  };
  assert.equal((await f.call('call_read_only_tool', { name: 'mcp_b__read', arguments: {} })).body.result.isError, true);
  assert.equal(f.state.calls.length, 0);
  f.state.valid = false;
  assert.equal((await f.call('search_tools', {})).status, 401);
});

test('a read tool becoming a writer while connecting cannot bypass manual approval through call_tool', async (t) => {
  const f = fixture(t);
  f.state.ask = true;
  f.state.beforeExecute = () => {
    f.catalog[0]!.annotations = {};
  };
  assert.equal((await f.call('call_tool', { name: 'mcp_a__read', arguments: {} })).body.result.isError, true);
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.approvals.length, 0);
});

test('a large external catalog reduces startup payload without shortening retained schemas', async (t) => {
  const f = fixture(t);
  f.catalog.splice(
    0,
    f.catalog.length,
    ...Array.from({ length: 100 }, (_, i) => ({
      name: `mcp_a__tool_${i.toString().padStart(3, '0')}`,
      server: 'a',
      description: 'Synthetic external tool',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', description: 's'.repeat(2000), properties: { value: { type: 'string' } } },
    })),
  );
  const compact = JSON.stringify((await f.request('tools/list')).body.result);
  f.state.deferredTools = false;
  const full = JSON.stringify((await f.request('tools/list')).body.result);
  assert.ok(compact.length < full.length / 4);
  t.diagnostic(
    `Synthetic 100-tool startup catalog: ${full.length} -> ${compact.length} characters; no model timing claimed.`,
  );
});
