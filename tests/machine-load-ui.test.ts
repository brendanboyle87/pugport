import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowTrace } from '../src/ui/Workspace.tsx';
import { QueueItem } from '../src/ui/TaskQueue.tsx';
import { machineLoadReasons } from '../src/shared/machine-load.ts';
import { workflowDisplayStatus } from '../src/ui/queue-utils.ts';
import type { AppState, Workflow } from '../src/shared/types.ts';

const workflow: Workflow = {
  id: 'busy',
  status: 'waiting-resource',
  machineLoadChoice: 'wait',
  scheduling: {
    reason: machineLoadReasons.memory,
    estimatedMinutes: 1,
    lastEvaluatedAt: '2026-10-13T00:00:00Z',
  },
  input: { content: 'Synthetic task', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-only' },
  conversationId: 'conversation',
  projectId: 'project',
  userMessageId: 'message',
  phase: 'queue',
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
  runIds: [],
  plan: [],
};

function props(value: Workflow) {
  return {
    workflow: value,
    state: { workflows: [value], runs: [], targets: [], runtimes: [], settings: {} } as unknown as AppState,
    api: async <T>() => undefined as T,
    notify() {},
    onInspect() {},
    onConversation() {},
    now: Date.parse(value.createdAt),
  };
}

for (const choice of ['wait', 'pending'] as const) {
  test(`${choice} memory wait renders one quiet status with a spinner and no load actions`, () => {
    const value = { ...workflow, machineLoadChoice: choice };
    const html = renderToStaticMarkup(createElement(WorkflowTrace, props(value)));
    assert.equal(workflowDisplayStatus(value, []).label, '排队中');
    assert.match(html, /spinning/);
    assert.match(html, /排队中/);
    assert.ok(html.includes(machineLoadReasons.memory));
    assert.doesNotMatch(html, /电脑负载选择|立即运行|等空闲时自动运行|等待选择|machine-load-actions|role="dialog"/);
  });

  test(`${choice} memory wait is collapsed in the task list without load actions`, () => {
    const html = renderToStaticMarkup(createElement(QueueItem, props({ ...workflow, machineLoadChoice: choice })));
    assert.match(html, /排队中/);
    assert.ok(html.includes(machineLoadReasons.memory));
    assert.doesNotMatch(html, /<details[^>]*open|电脑负载选择|立即运行|等空闲时自动运行|等待选择/);
  });
}

test('CPU-only bypass is displayed as running and retains no load prompt', () => {
  const value: Workflow = { ...workflow, status: 'running', machineLoadChoice: 'once' };
  const html = renderToStaticMarkup(createElement(WorkflowTrace, props(value)));
  assert.match(html, /正在执行/);
  assert.doesNotMatch(html, /电脑负载选择|立即运行|等空闲时自动运行|等待选择/);
});
