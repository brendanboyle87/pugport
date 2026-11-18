import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionChildTree,
  requestExecutionRecord,
  type WorkflowExecutionRecord,
  type ExecutionRecordRequestState,
} from '../src/ui/execution-records.ts';
import type { RunRecord } from '../src/shared/types.ts';
import { uiBundle, uiHarness, findNode, nextTurn, type UiNode } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/App.tsx');
function run(id: string, workflowId = 'task'): RunRecord {
  return {
    id,
    workflowId,
    prompt: 'INTERNAL GENERATED CONTEXT',
    projectPath: 'C:/synthetic',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'general', reasons: [], warnings: [] },
    startedAt: '2026-10-09T12:00:00Z',
    output: 'INTERNAL EXECUTOR OUTPUT',
    events: [],
  };
}
function detail(selected: RunRecord, runs = [selected], relatedRuns: RunRecord[] = []): WorkflowExecutionRecord {
  return {
    workflow: { id: selected.workflowId } as WorkflowExecutionRecord['workflow'],
    runs,
    relatedRuns,
    userInput: '  ORIGINAL HUMAN REQUEST\n  ',
    finalOutput: `FINAL REPLY ${selected.workflowId}`,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function nodes(tree: unknown, predicate: (node: UiNode) => boolean): UiNode[] {
  if (Array.isArray(tree)) return tree.flatMap((item) => nodes(item, predicate));
  if (!tree || typeof tree !== 'object') return [];
  const node = tree as UiNode;
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)];
}

test('one durable workflow endpoint supplies more than 200 attempts and every descendant without unrelated fetches', async () => {
  const selected = run('selected');
  const attempts = [...Array.from({ length: 250 }, (_, index) => run(`old-${index}`)), selected];
  const child = { ...run('child', 'child-workflow'), parentRunId: 'old-0' };
  const grandchild = { ...run('grandchild', 'grandchild-workflow'), parentRunId: child.id };
  const unknownCaller = run('missing-caller', 'associated-workflow');
  const record = detail(selected, attempts, [child, grandchild, unknownCaller]);
  record.relatedWorkflows = [{ id: 'associated-workflow', delegation: { parentId: 'task' } }] as any;
  const calls: string[] = [];
  const harness = uiHarness(await bundle);
  const props = {
    run: { ...selected, summary: true },
    runtimes: [],
    initialTab: 'trajectory',
    relatedRuns: Array.from({ length: 300 }, (_, index) => ({
      ...run(`unrelated-${index}`, 'other-task'),
      summary: true,
    })),
    api: async (path: string) => {
      calls.push(path);
      return record;
    },
    notify() {},
    onHandoff() {},
  };
  harness.render('RunOutput', props);
  await nextTurn();
  const tree = harness.render('RunOutput', props);
  const traceIds = nodes(tree, (node) => node.type?.name === 'TrajectoryPanel').map((node) => node.props.run.id);
  assert.equal(traceIds.length, 254);
  assert.equal(new Set(traceIds).size, 254);
  assert.ok(traceIds.includes('old-0') && traceIds.includes('grandchild') && traceIds.includes('missing-caller'));
  assert.deepEqual(calls, ['/api/workflows/task/execution-record']);
  assert.ok(findNode(tree, (node) => node.props['aria-label'] === '父任务 task 的关联子任务'));
  assert.equal(findNode(tree, (node) => node.type === 'pre')?.props.children, 'FINAL REPLY task');
  assert.equal(
    findNode(tree, (node) => node.props.className === 'run-prompt')?.props.children[1].props.children,
    record.userInput,
  );
  harness.unmount();
});

test('request cancellation and workflow/run identity reject late or foreign results', async () => {
  const old = deferred<WorkflowExecutionRecord>();
  const changes: ExecutionRecordRequestState[] = [];
  const pending = requestExecutionRecord(
    <T>() => old.promise as Promise<T>,
    'first',
    'first-run',
    (state) => changes.push(state),
  );
  pending.cancel();
  const selected = run('next-run', 'next');
  await requestExecutionRecord(
    async <T>() => detail(selected) as T,
    'next',
    selected.id,
    (state) => changes.push(state),
  ).promise;
  old.resolve(detail(run('first-run', 'first')));
  await pending.promise;
  assert.deepEqual(
    changes.map((state) => [state.workflowId, state.status]),
    [
      ['first', 'loading'],
      ['next', 'loading'],
      ['next', 'ready'],
    ],
  );
  const rejected: ExecutionRecordRequestState[] = [];
  await requestExecutionRecord(
    async <T>() => detail(run('foreign', 'foreign')) as T,
    'wanted',
    'wanted-run',
    (state) => rejected.push(state),
  ).promise;
  assert.equal(rejected.at(-1)?.status, 'failed');
  assert.ok(rejected.every((state) => state.workflowId === 'wanted'));
});

test('switching selection clears the previous final reply and visible failures support retry', async () => {
  const first = run('first-run', 'first');
  const second = run('second-run', 'second');
  const delayed = deferred<WorkflowExecutionRecord>();
  let failed = false;
  const harness = uiHarness(await bundle);
  const api = async (path: string) =>
    path.includes('/first/') ? detail(first) : failed ? detail(second) : delayed.promise;
  const props = { run: first, runtimes: [], api, notify() {}, onHandoff() {} };
  harness.render('RunOutput', props);
  await nextTurn();
  let tree = harness.render('RunOutput', props);
  assert.equal(findNode(tree, (node) => node.type === 'pre')?.props.children, 'FINAL REPLY first');
  props.run = second;
  tree = harness.render('RunOutput', props);
  assert.equal(
    findNode(tree, (node) => node.type === 'pre'),
    undefined,
  );
  delayed.reject(new Error('synthetic ledger unavailable'));
  await nextTurn();
  tree = harness.render('RunOutput', props);
  const alert = findNode(tree, (node) => node.props.role === 'alert');
  assert.ok(alert);
  assert.ok(JSON.stringify(alert.props.children).includes('synthetic ledger unavailable'));
  failed = true;
  findNode(alert, (node) => node.type === 'button')!.props.onClick();
  harness.render('RunOutput', props);
  await nextTurn();
  tree = harness.render('RunOutput', props);
  assert.equal(findNode(tree, (node) => node.type === 'pre')?.props.children, 'FINAL REPLY second');
  harness.unmount();
});

test('streaming updates coalesce for 400ms, terminal refresh is immediate, and selection cleanup cancels the timer', async () => {
  const timers = new Map<number, () => void>();
  let serial = 0;
  let requests = 0;
  const selected = { ...run('selected'), status: 'running' as const };
  const harness = uiHarness(await bundle, {
    setTimeout: (fn: () => void, ms: number) => {
      assert.equal(ms, 400);
      timers.set(++serial, fn);
      return serial;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const props = {
    run: selected as RunRecord,
    runtimes: [],
    api: async () => {
      requests++;
      return detail(props.run);
    },
    notify() {},
    onHandoff() {},
  };
  harness.render('RunOutput', props);
  await nextTurn();
  harness.render('RunOutput', props);
  assert.equal(requests, 1);
  for (let index = 1; index <= 10; index++) {
    props.run = { ...props.run, output: `stream ${index}` };
    harness.render('RunOutput', props);
  }
  assert.equal(requests, 1);
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0]!;
  timers.clear();
  timer();
  await nextTurn();
  harness.render('RunOutput', props);
  assert.equal(requests, 2);
  props.run = { ...props.run, output: 'more stream' };
  harness.render('RunOutput', props);
  assert.equal(timers.size, 1);
  props.run = { ...props.run, status: 'completed' };
  harness.render('RunOutput', props);
  await nextTurn();
  harness.render('RunOutput', props);
  assert.equal(requests, 3);
  assert.equal(timers.size, 0);
  props.run = { ...run('other', 'other-task'), status: 'running' };
  harness.render('RunOutput', props);
  await nextTurn();
  harness.render('RunOutput', props);
  props.run = { ...props.run, output: 'pending stream' };
  harness.render('RunOutput', props);
  assert.equal(timers.size, 1);
  harness.unmount();
  assert.equal(timers.size, 0);
});

test('explicit parent relations recurse while missing relations and cycles remain visible without guessed attempt parents', () => {
  const parent = run('parent');
  const child = { ...run('child', 'child-task'), parentRunId: parent.id };
  const grandchild = { ...run('grandchild', 'grandchild-task'), parentRunId: child.id };
  const unknown = run('unknown', 'unknown-task');
  const cyclic = { ...run('cyclic', 'cycle-task'), parentRunId: 'cyclic' };
  const tree = executionChildTree([parent], [child, grandchild, unknown, cyclic], [
    { id: 'unknown-task', delegation: { parentId: 'task' } },
  ] as any);
  assert.deepEqual(
    tree.children.get(parent.id)?.map((record) => record.id),
    ['child'],
  );
  assert.deepEqual(
    tree.children.get(child.id)?.map((record) => record.id),
    ['grandchild'],
  );
  assert.deepEqual(
    tree.workflowChildren.get('task')?.map((record) => record.id),
    ['unknown'],
  );
  assert.deepEqual(
    tree.unassociated.map((record) => record.id),
    ['cyclic'],
  );
});
