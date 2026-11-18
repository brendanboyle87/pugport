import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { Workspace } from '../src/server/workspace.ts';

test('MCP follow rejects a server mention before forwarding the message', async () => {
  const tasks = Object.create(ExternalTasks.prototype) as {
    workspace: unknown;
    conversationOf: () => unknown;
    follow: ExternalTasks['follow'];
  };
  tasks.conversationOf = () => ({ projectId: 'fixture' });
  tasks.workspace = {
    store: { get: () => undefined },
    controller: { settings: {} },
    remote: { directory: () => [{ id: 'fixture', name: 'fixture-server', tunnel: true }] },
  };
  let sent = false;
  await assert.rejects(
    tasks.follow('fixture', { message: '@@@fixture-server run' }, async () => {
      sent = true;
      return {};
    }),
    /cannot send messages to servers/,
  );
  assert.equal(sent, false);
});

test('resolving a tunnel device does not connect before delegation authorization', async () => {
  let ensures = 0;
  const bridge = Object.create(AgentBridge.prototype) as {
    workspace: unknown;
    agentNamed(name: string, write: boolean): Promise<unknown>;
  };
  bridge.workspace = {
    remote: {
      find: () => ({ id: 'fixture', name: 'fixture-server' }),
      directory: () => [{ id: 'fixture', name: 'fixture-server', tunnel: true }],
      ensureReachable: async () => {
        ensures++;
      },
    },
  };
  await bridge.agentNamed('fixture-server', false);
  assert.equal(ensures, 0);
});

test('delegation refuses a server absent from the parent participants', () => {
  const parent = { id: 'parent', projectId: 'p', conversationId: 'c', input: { participants: [] } };
  const workspace = Object.create(Workspace.prototype) as {
    store: unknown;
    active: Set<string>;
    remote: unknown;
    controller: unknown;
    assertProjectDelegation(): void;
    assertSwarmDelegation(): void;
    requireConversation(): unknown;
    requireProject(): unknown;
    routingContext(): unknown;
    prepareDelegation(id: string, agent: unknown, task: string, options: unknown): unknown;
  };
  workspace.store = { get: (kind: string) => (kind === 'workflow' ? parent : {}) };
  workspace.active = new Set(['parent']);
  workspace.remote = { directory: () => [{ id: 'server', name: 'fixture-server', tunnel: true }] };
  workspace.controller = { targets: [], snapshots: [] };
  workspace.assertProjectDelegation = () => {};
  workspace.assertSwarmDelegation = () => {};
  workspace.requireConversation = () => ({});
  workspace.requireProject = () => ({});
  workspace.routingContext = () => ({});
  assert.throws(
    () => workspace.prepareDelegation('parent', { label: 'fixture-server', deviceId: 'server' }, 'inspect', {}),
    /@@@/,
  );
});
