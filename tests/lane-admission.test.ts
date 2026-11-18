import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { ExecuteContext, Workflow } from '../src/shared/types.ts';
import { finished, fixture, input, result } from './helpers/session-workspace.ts';

const GB = 1024 ** 3;
async function until(check: () => boolean, label: string) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
}

test('lane turns start by available memory while ordinary chats keep running', async (t) => {
  const f = fixture(t);
  let memory = 9 * GB;
  f.controller.machineReading = () => ({ totalBytes: 32 * GB, cpus: 16, availableMemoryBytes: memory });
  const entered = new Set<string>();
  let gate = Promise.resolve(),
    open = () => {};
  const hold = () => (gate = new Promise<void>((resolve) => (open = resolve)));
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    entered.add(ctx.input.workflowId!);
    await Promise.race([
      gate,
      new Promise<never>((_, reject) =>
        ctx.signal.addEventListener('abort', () => reject(new Error('operation-cancelled')), { once: true }),
      ),
    ]);
    return result('completed', 'Synthetic turn finished.');
  });
  const project = await f.workspace.createProject(f.directory);
  const send = async (conversationId: string, content: string) =>
    (await f.workspace.send(conversationId, { ...input, content, runtimeId: 'mock', permissionMode: 'read-only' }))
      .workflow.id;
  const coordinator = f.workspace.createConversation(project.id, 'Coordinator');
  const source = await send(coordinator.id, 'Synthetic coordinator turn.');
  await finished(f.workspace, source);
  const lanes = ['A', 'B', 'C', 'D'].map((title) => {
    const lane = f.workspace.createConversation(project.id, `Lane ${title}`);
    lane.lane = { parentConversationId: coordinator.id, sourceWorkflowId: source };
    f.workspace.store.save('conversation', lane.id, project.id, lane);
    return lane;
  });
  const flow = (id: string) => f.workspace.store.get<Workflow>('workflow', id)!;
  const waitingFor = (id: string, reason: RegExp) =>
    flow(id).status === 'waiting-resource' && reason.test(flow(id).scheduling?.reason ?? '');

  hold();
  const turns: string[] = [];
  for (const [index, lane] of lanes.entries()) turns.push(await send(lane.id, `Synthetic lane turn ${index}.`));
  const [first, second, third, fourth] = turns as [string, string, string, string];
  await until(
    () => [first, second, third].every((id) => entered.has(id)) && waitingFor(fourth, /工作线最多同时 3 条/),
    '9 GB: three lanes run and the fourth waits',
  );
  await f.workspace.tickQueue();
  assert.equal(entered.has(fourth), false);

  memory = 3 * GB;
  const chat = await send(f.workspace.createConversation(project.id, 'Ordinary').id, 'Synthetic ordinary chat.');
  await until(() => entered.has(chat), 'an ordinary chat is not held by the lane pool');
  await f.workspace.tickQueue();
  await until(() => waitingFor(fourth, /低于 4 GB/), '3 GB: no new lane turn');

  open();
  for (const id of [first, second, third, chat]) await finished(f.workspace, id);
  hold();
  await f.workspace.tickQueue();
  assert.equal(entered.has(fourth), false, 'under 4 GB no lane starts even with every lane idle');
  assert.equal(flow(fourth).status, 'waiting-resource');

  memory = 5 * GB;
  await f.workspace.tickQueue();
  await until(() => entered.has(fourth), '5 GB: one lane starts');
  const again = await send(lanes[0]!.id, 'Synthetic second lane turn.');
  await until(() => waitingFor(again, /工作线最多同时 1 条/), '5 GB: a second lane waits');

  memory = 9 * GB;
  await f.workspace.tickQueue();
  await until(() => entered.has(again), '9 GB again: the waiting lane starts');
  open();
  for (const id of [fourth, again]) await finished(f.workspace, id);
});
