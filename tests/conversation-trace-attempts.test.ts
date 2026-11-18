import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { AppState, RunRecord, Workflow } from '../src/shared/types.ts';
import type { ConversationTraceProps } from '../src/ui/ConversationTrace.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const stamp = '2026-10-29T12:00:00.000Z';
function workflow(id: string, patch: Partial<Workflow> = {}): Workflow {
  return {
    id,
    conversationId: 'chat',
    projectId: 'project',
    userMessageId: 'original-message',
    input: { content: 'Synthetic request', mode: 'auto', permissionMode: 'read-only', executionPolicy: 'cli-first' },
    status: 'completed',
    phase: 'summarize',
    plan: [],
    runIds: [`${id}-run`],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
  };
}
function run(task: Workflow, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: task.runIds[0]!,
    workflowId: task.id,
    prompt: 'Synthetic request',
    projectPath: 'C:/fixture',
    kind: 'routine',
    status: task.status === 'completed' ? 'completed' : 'failed',
    route: { runtimeId: 'codex', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
    startedAt: stamp,
    endedAt: stamp,
    output: `Output from ${task.id}`,
    events: [],
    ...patch,
  };
}
function props(tasks: Workflow[], runs = tasks.map((task) => run(task))): ConversationTraceProps {
  return {
    conversation: { id: 'chat', title: 'Synthetic chat' },
    workflows: tasks,
    messages: [
      {
        id: 'original-message',
        conversationId: 'chat',
        role: 'user',
        content: 'One original message',
        workflowId: tasks.at(-1)!.id,
        createdAt: stamp,
      },
    ],
    state: { runs, targets: [], runtimes: [] } as unknown as AppState,
    api: async <T>(path: string) =>
      ({
        workflow: tasks.find((task) => path.includes(`/${task.id}/`))!,
        runs: runs.filter((item) => path.includes(`/${item.workflowId}/`)),
        relatedRuns: [],
      }) as T,
    notify() {},
    onClose() {},
    onInspect() {},
  };
}
function records(tree: unknown): UiNode[] {
  const rows: UiNode[] = [];
  findNode(tree, (node) => {
    if (node.props.role === 'option') rows.push(node);
    return false;
  });
  return rows;
}
let code: string;
before(async () => {
  code = await uiBundle('src/ui/ConversationTrace.tsx');
});

test('trace selector keeps both resend attempts with order, status and failure reason, and opens either run', async () => {
  const failed = workflow('first', { status: 'failed', error: 'Executor process exited', supersededBy: 'second' });
  const completed = workflow('second', { attempt: 2, createdAt: '2026-10-29T12:01:00.000Z' });
  const fixture = props([failed, completed]);
  const paths: string[] = [];
  const api = fixture.api;
  fixture.api = async <T>(path: string) => {
    paths.push(path);
    return api<T>(path);
  };
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  let rows = records(tree);
  assert.deepEqual(
    rows.map((row) => row.props['data-workflow-id']),
    ['first', 'second'],
  );
  assert.match(text(rows[0]), /第 1 次 · 执行失败 · Executor process exited/);
  assert.match(text(rows[1]), /第 2 次 · 已完成/);
  assert.equal(rows[1]!.props['aria-selected'], true);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')?.props.run.id, 'second-run');
  rows[0]!.props.onClick();
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  tree = ui.render('ConversationTrace', fixture);
  rows = records(tree);
  assert.equal(rows[0]!.props['aria-selected'], true);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')?.props.run.id, 'first-run');
  assert.deepEqual(paths, ['/api/workflows/second/execution-record', '/api/workflows/first/execution-record']);
  ui.unmount();
});

test('trace attempt labels distinguish blocked, interrupted and stopped, and use retained run errors', () => {
  const cases: Array<{ status: Workflow['status']; stopped?: Workflow['stopped']; label: string }> = [
    { status: 'blocked', label: '需要处理' },
    { status: 'interrupted', label: '已中断' },
    { status: 'cancelled', stopped: true, label: '已停止' },
  ];
  for (const item of cases) {
    const failed = workflow('first', { status: item.status, stopped: item.stopped, supersededBy: 'second' });
    const completed = workflow('second', { attempt: 2, createdAt: '2026-10-29T12:01:00.000Z' });
    const fixture = props([failed, completed], [run(failed, { error: 'Saved run reason' }), run(completed)]);
    const ui = uiHarness(code);
    const rows = records(ui.render('ConversationTrace', fixture));
    assert.ok(text(rows[0]).includes(`第 1 次 · ${item.label} · Saved run reason`), text(rows[0]));
    assert.doesNotMatch(text(rows[1]), /Saved run reason/);
    ui.unmount();
  }
});

test('legacy records and delegated children retain their existing labels and nesting', () => {
  const legacy = workflow('legacy', { userMessageId: 'legacy-message' });
  const child = workflow('child', {
    userMessageId: 'child-message',
    delegation: { parentId: legacy.id, role: 'worker', requestId: 'synthetic' },
    createdAt: '2026-10-29T12:01:00.000Z',
  });
  const ui = uiHarness(code);
  const rows = records(ui.render('ConversationTrace', props([legacy, child])));
  assert.deepEqual(
    rows.map((row) => row.props['data-depth']),
    [0, 1],
  );
  assert.doesNotMatch(text(rows), /第 \d+ 次/);
  ui.unmount();
});
