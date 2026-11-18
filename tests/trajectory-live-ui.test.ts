import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEvent, RunRecord } from '../src/shared/types.ts';
import { findNode, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8) + seconds * 1000).toISOString();
const record = (patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'live-run',
  prompt: 'Inspect the fixture',
  projectPath: 'C:/fixture',
  kind: 'routine',
  status: 'running',
  startedAt: at(0),
  output: '',
  route: { runtimeId: 'pi', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
  events: [],
  ...patch,
});
const bundle = uiBundle('src/ui/Trajectory.tsx');

test('streamed text, output and reasoning bursts derive at most once per live timer window', async () => {
  let derivations = 0;
  const events: RunEvent[] = [{ type: 'text', at: at(1), seq: 0, text: 'Initial' }];
  // deriveTrajectory traverses entries once. Observe that existing boundary without a public test option.
  Object.defineProperty(events, 'entries', {
    value() {
      derivations++;
      return Array.prototype.entries.call(this);
    },
  });
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const harness = uiHarness(await bundle, {
    setInterval(fn: () => void, milliseconds: number) {
      assert.equal(milliseconds, 1000);
      timers.set(++timerId, fn);
      return timerId;
    },
    clearInterval(id: number) {
      timers.delete(id);
    },
  });
  let run = record({ events, reasoning: 'AA' });
  harness.render('TrajectoryPanel', { run });
  assert.equal(derivations, 1);
  for (let index = 1; index <= 40; index++) {
    events.push({ type: 'text', at: at(index), seq: index, text: `chunk-${index}` });
    run = { ...run, output: `Output ${index}`, reasoning: index % 2 ? 'BB' : 'CC' };
    harness.render('TrajectoryPanel', { run });
  }
  assert.equal(derivations, 1, 'every text delta must share the same live projection');
  assert.equal(timers.size, 1, 'a burst must not replace or multiply the timer');
  [...timers.values()][0]();
  let tree = harness.render('TrajectoryPanel', { run });
  assert.equal(derivations, 2);
  assert.match(text(tree), /CC/);
  run = { ...run, reasoning: 'DD' };
  harness.render('TrajectoryPanel', { run });
  assert.equal(derivations, 2);
  [...timers.values()][0]();
  tree = harness.render('TrajectoryPanel', { run });
  assert.equal(derivations, 3);
  assert.match(text(tree), /DD/, 'same-length reasoning at its cap must update on the next tick');

  run = { ...run, status: 'completed', endedAt: at(50), reasoning: 'EE' };
  tree = harness.render('TrajectoryPanel', { run });
  assert.equal(derivations, 4, 'terminal state bypasses the live timer');
  assert.equal(timers.size, 0);
  assert.match(text(tree), /EE/);
  run = { ...run, reasoning: 'FF' };
  tree = harness.render('TrajectoryPanel', { run });
  assert.equal(derivations, 5, 'terminal reasoning is keyed by value, not length');
  assert.match(text(tree), /FF/);
  run = { ...run, id: 'different-run', status: 'running', endedAt: undefined };
  harness.render('TrajectoryPanel', { run });
  assert.equal(derivations, 6, 'switching runs derives immediately');
  assert.equal(timers.size, 1);
  harness.unmount();
  assert.equal(timers.size, 0);
});

test('a live timeline keeps the all-run axis and recorded duration through tools and empty-error filters', async () => {
  const run = record({
    events: [
      { type: 'tool', at: at(10), data: { toolCallId: 'one', tool: 'read_file', status: 'started' } },
      { type: 'tool', at: at(12), data: { toolCallId: 'one', tool: 'read_file', status: 'completed' } },
      { type: 'status', at: at(100), text: 'Later observation' },
    ],
  });
  const harness = uiHarness(await bundle);
  let tree = harness.render('TrajectoryPanel', { run });
  const axis = text(findNode(tree, (node) => node.props.className === 'trajectory-axis'));
  const initial = findNode(tree, (node) => node.props['data-lane'] === 'tools')!.props.style;
  const recorded = text(findNode(tree, (node) => node.props.className === 'trajectory-heading'));
  findNode(tree, (node) => node.type === 'button' && node.props.children === '工具')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run });
  assert.equal(text(findNode(tree, (node) => node.props.className === 'trajectory-axis')), axis);
  assert.equal(text(findNode(tree, (node) => node.props.className === 'trajectory-heading')), recorded);
  assert.deepEqual(findNode(tree, (node) => node.props['data-lane'] === 'tools')!.props.style, initial);
  findNode(tree, (node) => node.type === 'button' && node.props.children === '错误')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run });
  assert.equal(text(findNode(tree, (node) => node.props.className === 'trajectory-axis')), axis);
  assert.equal(text(findNode(tree, (node) => node.props.className === 'trajectory-heading')), recorded);
  harness.unmount();
});

test('a protocol fold outside the list window is first and still expandable', async () => {
  const run = record({
    status: 'completed',
    endedAt: at(100),
    events: [
      {
        type: 'status',
        at: at(0),
        data: { source: 'pugport', kind: 'startup-timing', detail: { fixture: 'startup' } },
      },
      ...Array.from({ length: 70 }, (_, index): RunEvent => ({
        type: 'tool',
        at: at(index + 1),
        data: { toolCallId: `tool-${index}`, tool: 'read_file', status: 'completed' },
      })),
    ],
  });
  const harness = uiHarness(await bundle);
  let tree = harness.render('TrajectoryPanel', { run });
  const list = findNode(tree, (node) => node.props.className === 'trajectory-list')!;
  const entries: UiNode[] = [];
  findNode(list, (node) => {
    if (node.type === 'article' || node.props.className === 'trajectory-protocol') entries.push(node);
    return false;
  });
  assert.equal(entries[0].props.className, 'trajectory-protocol');
  const toggle = findNode(list, (node) => node.props.className === 'trajectory-protocol-toggle')!;
  assert.equal(text(toggle), '协议事件 ×1');
  toggle.props.onClick();
  tree = harness.render('TrajectoryPanel', { run });
  assert.ok(findNode(tree, (node) => node.props.className === 'trajectory-protocol-rows'));
  harness.unmount();
});

test('hideContextRows omits the empty input lane', async () => {
  const harness = uiHarness(await bundle);
  const tree = harness.render('TrajectoryPanel', { run: record(), hideContextRows: true });
  const lanes: string[] = [];
  findNode(tree, (node) => {
    if (node.props.className === 'trajectory-lane') lanes.push(text(node.props.children[0]));
    return false;
  });
  assert.deepEqual(lanes, ['模型', '工具', '状态']);
  harness.unmount();
});
