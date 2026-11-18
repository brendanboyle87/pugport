import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  swarmActiveCount,
  swarmAgentId,
  swarmAgents,
  swarmDepth,
  swarmFamily,
  swarmRoot,
} from '../src/shared/swarm.ts';
import type { Workflow } from '../src/shared/types.ts';

const item = (id: string, parentId?: string, previous?: string) =>
  ({
    id,
    projectId: 'project',
    conversationId: 'conversation',
    input: { swarm: true, content: id },
    createdAt: `2026-10-09T00:00:${id.length.toString().padStart(2, '0')}Z`,
    ...(parentId ? { delegation: { parentId, requestId: id, role: 'scout' } } : {}),
    ...(previous ? { parentWorkflowId: previous } : {}),
  }) as Workflow;

test('swarm tree merges continuations and keeps distinct roots, complete history, and nested depth', () => {
  const rows = [
    item('root'),
    item('root-v2', undefined, 'root'),
    item('child', 'root-v2'),
    item('child-v2', 'root-v2', 'child'),
    item('nested', 'child-v2'),
    item('other-root'),
    item('other-child', 'other-root'),
  ];
  assert.equal(swarmAgentId('child-v2', rows), 'child');
  assert.equal(swarmRoot('nested', rows), 'root');
  assert.equal(swarmDepth('nested', rows), 2);
  assert.equal(swarmFamily('nested', rows).length, 5);
  const agents = swarmAgents('root-v2', rows);
  assert.equal(agents.length, 3);
  assert.equal(agents.find((agent) => agent.id === 'root')!.workflow.id, 'root-v2');
  assert.deepEqual(agents.find((agent) => agent.id === 'child')!.workflowIds, ['child', 'child-v2']);
  assert.equal(agents.find((agent) => agent.id === 'nested')!.parentId, 'child');
});

test('cycles, missing ancestors, and cross-project/conversation links fail closed', () => {
  for (const rows of [
    [item('a', 'b'), item('b', 'a')],
    [item('a', undefined, 'b'), item('b', undefined, 'a')],
    [item('a', 'missing')],
    [item('a', 'b'), { ...item('b'), projectId: 'elsewhere' }],
    [item('a', undefined, 'b'), { ...item('b'), conversationId: 'elsewhere' }],
  ]) {
    assert.equal(swarmRoot('a', rows), undefined);
    assert.equal(swarmDepth('a', rows), undefined);
    assert.deepEqual(swarmFamily('a', rows), []);
  }
});

test('swarm capacity counts a computing root, excludes parked callers, and includes pending starts exactly once', () => {
  const rows = [item('root'), item('one', 'root'), item('two', 'root'), item('three', 'root'), item('other-root')];
  const executions = rows.map((workflow) => ({ workflowId: workflow.id, executing: true, parked: false }));
  assert.equal(swarmActiveCount('one', rows, executions), 4);
  executions[0]!.parked = true;
  assert.equal(swarmActiveCount('root', rows, executions), 3);
  assert.equal(swarmActiveCount('root', rows, [...executions, { workflowId: 'root', pendingStart: true }]), 4);
  assert.equal(swarmActiveCount('root', rows, [...executions, { workflowId: 'one', pendingStart: true }]), 3);
});
