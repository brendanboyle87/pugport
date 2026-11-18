import assert from 'node:assert/strict';
import test from 'node:test';
import { uiBundle, uiHarness, findNode, nextTurn } from './helpers/ui-harness.ts';
import type { RunRecord } from '../src/shared/types.ts';

const bundle = uiBundle('src/ui/App.tsx');
const stamp = '2026-10-08T12:00:00Z';
const record: RunRecord = {
  id: 'fixture-run',
  prompt: 'generated internal execution context',
  workflowId: 'fixture-workflow',
  projectPath: 'C:/Fixture',
  kind: 'routine',
  status: 'completed',
  route: { runtimeId: 'fixture', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
  startedAt: stamp,
  endedAt: stamp,
  output: 'Synthetic final reply',
  eventsDropped: 0,
  events: [
    { seq: 1, at: stamp, type: 'tool', data: { toolCallId: 'fixture-call', tool: 'Read', status: 'completed' } },
  ],
};
const panel = (tree: unknown) => findNode(tree, (node) => node.type?.name === 'TrajectoryPanel');
const workflowRecord = (run = record) => ({
  workflow: { id: record.workflowId },
  runs: [run],
  relatedRuns: [],
  relatedWorkflows: [],
  userInput: 'Original user task',
  finalOutput: 'PugPort final task reply',
});

test('opening trajectory loads finished run detail, keeps original input and forwards child inspection', async () => {
  const calls: string[] = [];
  const inspect = (id: string) => calls.push(id);
  const harness = uiHarness(await bundle);
  const props = {
    run: { ...record, summary: true, events: [] },
    runtimes: [],
    targets: [],
    initialTab: 'trajectory',
    userInput: 'Original user task',
    relatedRuns: [record],
    api: async (path: string) => {
      calls.push(path);
      return workflowRecord();
    },
    notify() {},
    onHandoff() {},
    onInspectRun: inspect,
  };
  let tree = harness.render('RunOutput', props);
  assert.equal(panel(tree)?.props.run.summary, true);
  await nextTurn();
  tree = harness.render('RunOutput', props);
  assert.equal(panel(tree)?.props.run.events.length, 1);
  assert.equal(panel(tree)?.props.userInput, 'Original user task');
  assert.equal(panel(tree)?.props.onInspectRun, inspect);
  assert.deepEqual(calls, ['/api/workflows/fixture-workflow/execution-record']);
  harness.unmount();
});

test('live trajectory receives latest event props while detail refresh is coalesced and trajectory scroll stays fixed', async () => {
  const harness = uiHarness(await bundle);
  let requests = 0;
  const props = {
    run: { ...record, status: 'running' as const, endedAt: undefined },
    runtimes: [],
    initialTab: 'trajectory',
    api: async () => {
      requests++;
      return workflowRecord();
    },
    notify() {},
    onHandoff() {},
  };
  let tree = harness.render('RunOutput', props);
  const body = findNode(tree, (node) => node.props.className === 'output-body')!;
  const scroller = { scrollTop: 4, scrollHeight: 900 };
  body.props.ref.current = scroller;
  props.run = { ...props.run, events: [...props.run.events, { at: stamp, seq: 2, type: 'status', text: 'Updated' }] };
  tree = harness.render('RunOutput', props);
  assert.equal(panel(tree)?.props.run.events.length, 2);
  assert.equal(scroller.scrollTop, 4);
  assert.equal(requests, 1, 'the initial workflow GET is followed by a throttled live refresh');
  const outputTab = findNode(
    tree,
    (node) => node.props.role === 'tab' && node.props.children?.some?.((item: unknown) => item === '输出'),
  )!;
  outputTab.props.onClick();
  tree = harness.render('RunOutput', props);
  assert.equal(panel(tree), undefined);
  assert.equal(scroller.scrollTop, 900);
  harness.unmount();
});

test('finished detail retains complete output while later background SSE observations update its trajectory', async () => {
  const harness = uiHarness(await bundle);
  const props = {
    run: { ...record, summary: true, events: [] as RunRecord['events'], output: 'Broadcast tail' },
    runtimes: [],
    initialTab: 'trajectory',
    api: async () => workflowRecord(),
    notify() {},
    onHandoff() {},
  };
  harness.render('RunOutput', props);
  await nextTurn();
  props.run.events = [
    { seq: 2, at: stamp, type: 'status', data: { source: 'pugport', kind: 'internal-step', detail: { done: 3 } } },
  ];
  const tree = harness.render('RunOutput', props);
  assert.equal(panel(tree)?.props.run.events.length, 2);
  assert.equal(panel(tree)?.props.run.output, record.output);
  harness.unmount();
});

test('loading local audit merges older tool records with newer live events without duplicate sequences', async () => {
  const harness = uiHarness(await bundle);
  let requests = 0;
  const recent = { seq: 1001, at: stamp, type: 'tool' as const, data: { toolCallId: 'recent' } };
  const props = {
    run: { ...record, auditVersion: 1 as const, status: 'running' as const, eventsDropped: 10, events: [recent] },
    runtimes: [],
    initialTab: 'trajectory',
    api: async (path: string) => {
      requests++;
      const detailed = { ...record, events: [...record.events, recent] };
      return path.includes('/execution-record') ? workflowRecord(detailed) : detailed;
    },
    notify() {},
    onHandoff() {},
  };
  let tree = harness.render('RunOutput', props);
  panel(tree)!.props.onLoadFullAudit();
  await nextTurn();
  props.run.events = [recent, { ...recent, seq: 1002, data: { toolCallId: 'newest' } }];
  tree = harness.render('RunOutput', props);
  assert.equal(requests, 2, 'one workflow ledger load and one explicit per-run audit read');
  assert.deepEqual(
    Array.from(panel(tree)!.props.run.events, (event: any) => event.seq),
    [1, 1001, 1002],
  );
  harness.unmount();
});

test('loading an old snapshot preserves repeated legacy observations without duplicating its copied records', async () => {
  const harness = uiHarness(await bundle);
  const legacy = { at: stamp, type: 'tool' as const, text: 'Old tool observation' };
  const old = { ...record, events: [legacy, { ...legacy }] };
  const props = {
    run: { ...old, summary: true },
    runtimes: [],
    initialTab: 'trajectory',
    api: async (path: string) => (path.includes('/execution-record') ? workflowRecord(old) : old),
    notify() {},
    onHandoff() {},
  };
  harness.render('RunOutput', props);
  await nextTurn();
  let tree = harness.render('RunOutput', props);
  panel(tree)!.props.onLoadFullAudit();
  await nextTurn();
  tree = harness.render('RunOutput', props);
  assert.equal(panel(tree)!.props.run.events.length, 2);
  harness.unmount();
});
