import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationAutomation } from '../src/server/conversation-automation.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { SwarmPlanPanel, conversationPlan } from '../src/ui/SwarmWorkspace.tsx';
import type { Conversation, Project, Workflow } from '../src/shared/types.ts';

const at = '2026-10-27T12:00:00.000Z';
const items = [
  { id: 'read', title: 'Read the router', kind: 'read' as const },
  { id: 'lane', title: 'Rewrite the router', kind: 'write' as const },
];
const task = (id: string, conversationId: string, overrides: Partial<Workflow> = {}) =>
  ({
    id,
    projectId: 'project',
    conversationId,
    status: 'running',
    input: { content: id, mode: 'auto', permissionMode: 'workspace-write' },
    runIds: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }) as unknown as Workflow;
// Conversation mail checks ids as UUIDs.
const chatId = randomUUID(),
  laneId = randomUUID();
const chat = { id: chatId, projectId: 'project', title: 'Chat', createdAt: at, updatedAt: at } as Conversation;
const lane = {
  ...chat,
  id: laneId,
  title: 'Router lane',
  lane: { parentConversationId: chatId, sourceWorkflowId: 'root', planItem: 'lane' },
} as Conversation;

test('an ordinary chat’s plan links delegated members and lanes by item', () => {
  const root = task('root', chatId, { taskList: { items, updatedAt: at } });
  const reader = task('reader', chatId, {
    status: 'completed',
    delegation: { parentId: 'root', role: 'scout', requestId: 'r', planItem: 'read', agent: { label: 'Codex B' } },
  });
  const laneRoot = task('lane-root', laneId);
  const plan = conversationPlan([root, reader, laneRoot], [chat, lane], chatId)!;
  assert.deepEqual(
    plan.rows.map((row) => [row.id, row.state, row.who]),
    [
      ['read', 'done', 'Codex B'],
      ['lane', 'running', undefined],
    ],
  );
  assert.equal(conversationPlan([task('root', chatId)], [chat], chatId), undefined, 'no list, no panel');
  assert.equal(conversationPlan([reader], [chat], chatId), undefined, 'a member’s list is not the chat’s');
});

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'project', 'project', { id: 'project', path: 'C:/synthetic/plan' } as Project);
  for (const c of [chat, lane]) store.save('conversation', c.id, 'project', c);
  store.save(
    'workflow',
    'root',
    chatId,
    task('root', chatId, { status: 'completed', taskList: { items, updatedAt: at } }),
  );
  const workspace = {
    store,
    active: new Map(),
    controller: { dataDir: 'C:/synthetic/plan', broadcast() {}, activeRunFor: () => undefined },
    now: () => at,
    publish: (workflow: Workflow) => store.save('workflow', workflow.id, workflow.conversationId, workflow),
    memberResult: (_workflow: Workflow, text: string) => text,
    finishPlanItem: Workspace.prototype.finishPlanItem,
    taskListOwner: (Workspace.prototype as unknown as { taskListOwner: unknown }).taskListOwner,
    send: async () => ({ workflow: { id: 'wake' } }),
  } as unknown as Workspace;
  const automation = new ConversationAutomation(workspace);
  t.after(async () => {
    await automation.close();
    db.close();
  });
  const settle = (status: Workflow['status']) => {
    const id = randomUUID();
    const final = store.addMessage(laneId, 'assistant', 'Synthetic lane result.', id);
    store.save('workflow', id, laneId, task(id, laneId, { status, finalMessageId: final.id }));
  };
  return { store, automation, settle };
}

test('a finished lane keeps its item done after its task leaves the window', async (t) => {
  const f = fixture(t);
  f.settle('failed');
  await f.automation.tick();
  assert.equal(f.store.get<Workflow>('workflow', 'root')!.taskList!.items[1]!.done, undefined, 'a failure is not done');
  f.settle('completed');
  await f.automation.tick();
  const root = f.store.get<Workflow>('workflow', 'root')!;
  assert.equal(root.taskList!.items[1]!.done, true);
  const plan = conversationPlan([root], [chat, lane], chatId)!;
  assert.deepEqual(
    plan.rows.map((row) => row.state),
    ['queued', 'done'],
  );
  const html = renderToStaticMarkup(createElement(SwarmPlanPanel, { plan }));
  assert.match(html, /1\/2 完成/);
  assert.match(html, /class="swarm-plan-item done"[\s\S]*Rewrite the router/);
});
