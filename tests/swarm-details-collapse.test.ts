import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workflow } from '../src/shared/types.ts';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/SwarmWorkspace.tsx');
const at = '2026-10-24T12:00:00.000Z';
const workflow = (status: Workflow['status'], id = 'root', conversationId = 'chat'): Workflow => ({
  id,
  projectId: 'project',
  conversationId,
  userMessageId: 'message',
  input: {
    content: 'Synthetic task',
    swarm: true,
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  },
  status,
  phase: 'execute',
  runIds: [],
  plan: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: at,
  updatedAt: at,
});
const button = (tree: unknown, label: string) =>
  findNode(tree, (node) => node.type === 'button' && node.props['aria-label'] === label);
const toolbar = (tree: unknown) => findNode(tree, (node) => node.props.role === 'toolbar');
const planPanel = (tree: unknown) => findNode(tree, (node) => node.type?.name === 'SwarmPlanPanel');
function fixture(code: string, unavailable = false) {
  const saved = new Map<string, string>();
  const harness = uiHarness(code, {
    localStorage: {
      getItem: (key: string) => {
        if (unavailable) throw new Error('disabled');
        return saved.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (unavailable) throw new Error('disabled');
        saved.set(key, value);
      },
    },
  });
  const render = (task: Workflow) =>
    harness.render('SwarmWorkspaceView', {
      members: harness.exports.swarmMembers([task], [], []),
      communications: [],
      messages: [],
      loading: false,
      sending: false,
      draft: '',
      plan: { scope: task.id, rows: [{ id: 'task', title: 'Synthetic item', state: 'done', kind: 'read' }], done: 1 },
      onSelect() {},
      onDraft() {},
      onSend() {},
      onInspect() {},
    });
  return { harness, render, saved };
}

test('finished member and task bars default to one small recoverable entry', async () => {
  const f = fixture(await bundle);
  const task = workflow('completed');
  const original = structuredClone(task);
  let tree = f.render(task);
  assert.equal(toolbar(tree), undefined);
  assert.equal(planPanel(tree), undefined);
  assert.match(text(tree), /成员与任务.*1 位成员/);
  assert.equal(button(tree, '展开成员与任务')!.props['aria-expanded'], 'false');
  button(tree, '展开成员与任务')!.props.onClick();
  tree = f.render(task);
  assert.ok(toolbar(tree));
  assert.ok(planPanel(tree));
  const collapse = button(tree, '收起成员与任务')!;
  assert.equal(
    toolbar(tree)!.props.children[0],
    collapse,
    'the same left-hand entry expands and collapses the details',
  );
  assert.equal(text(collapse), '成员与任务');
  assert.equal(collapse.props['aria-expanded'], 'true');
  assert.match(collapse.props.className, /swarm-details-toggle swarm-details-hide/);
  assert.doesNotMatch(
    collapse.props.className,
    /icon-button/,
    'folding is a labeled disclosure, separate from task hide X',
  );
  button(tree, '收起成员与任务')!.props.onClick();
  tree = f.render(task);
  assert.equal(toolbar(tree), undefined);
  assert.equal(planPanel(tree), undefined);
  assert.ok(button(tree, '展开成员与任务'));
  assert.deepEqual(task, original, 'closing detail bars never changes the task or its history');
});

test('closing both bars persists per chat and root while new active groups remain expanded', async () => {
  const f = fixture(await bundle);
  const task = workflow('running');
  let tree = f.render(task);
  assert.ok(toolbar(tree));
  assert.ok(planPanel(tree));
  button(tree, '收起成员与任务')!.props.onClick();
  f.harness.remount();
  tree = f.render(task);
  assert.ok(button(tree, '展开成员与任务'));
  assert.match(text(tree), /1 位进行中/);
  assert.ok(findNode(tree, (node) => node.props.className === 'swarm-details-toggle active'));
  for (const other of [workflow('running', 'next-root'), workflow('running', 'root', 'other-chat')]) {
    tree = f.render(other);
    assert.ok(toolbar(tree), "another active group does not inherit the old group's preference");
    assert.ok(planPanel(tree));
  }
  tree = f.render(workflow('completed'));
  assert.ok(button(tree, '展开成员与任务'));
  tree = f.render(workflow('queued'));
  assert.match(text(tree), /1 位进行中/, 'a rerun makes active progress visible even while details stay collapsed');
  button(tree, '展开成员与任务')!.props.onClick();
  f.harness.remount();
  assert.ok(toolbar(f.render(task)), 'an explicit restore also survives remount');
});

test('whole-bar collapse still works in memory when device storage is unavailable', async () => {
  const f = fixture(await bundle, true);
  const task = workflow('running');
  button(f.render(task), '收起成员与任务')!.props.onClick();
  f.harness.remount();
  let tree = f.render(task);
  assert.equal(toolbar(tree), undefined);
  button(tree, '展开成员与任务')!.props.onClick();
  tree = f.render(task);
  assert.ok(toolbar(tree));
  assert.ok(planPanel(tree));
});
