import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { normalizeTaskList, swarmTimeSaved, taskListProgress, type TaskListItem } from '../src/shared/swarm.ts';
import {
  SwarmPlanPanel,
  SwarmWorkspaceView,
  savedTimeText,
  swarmMembers,
  swarmPlan,
  swarmSavedTime,
} from '../src/ui/SwarmWorkspace.tsx';
import type { MessageInput, RunRecord, Workflow } from '../src/shared/types.ts';

const at = '2026-10-10T08:00:00.000Z';
function task(id: string, parentId?: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    projectId: 'project',
    conversationId: 'conversation',
    userMessageId: `message-${id}`,
    input: {
      swarm: true,
      content: `Original request ${id}`,
      intentText: `Intent ${id}`,
      mode: 'build',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-first',
    },
    status: 'running',
    phase: 'execute',
    runIds: [`run-${id}`],
    plan: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: at,
    updatedAt: at,
    ...(parentId ? { delegation: { parentId, role: 'scout', requestId: id, agent: { label: `Agent ${id}` } } } : {}),
    ...overrides,
  };
}
const items: TaskListItem[] = [
  { id: 'read', title: '读现有路由代码', kind: 'read', assignee: '自动选择' },
  { id: 'write', title: '改写分配逻辑', kind: 'write' },
  { id: 'tests', title: '补测试', kind: 'write' },
  { id: 'self', title: '自己核对设计文档', kind: 'read', done: true },
];

test('a task list is checked strictly and refused with plain reasons', () => {
  assert.deepEqual(normalizeTaskList([{ id: 'a.1', title: '  读  文档 ', kind: 'read', assignee: ' Codex B ' }]), [
    { id: 'a.1', title: '读 文档', kind: 'read', assignee: 'Codex B' },
  ]);
  assert.throws(() => normalizeTaskList([]), /至少一项/);
  assert.throws(() => normalizeTaskList([{ id: 'has space', title: 'x', kind: 'read' }]), /id 只能用/);
  assert.throws(
    () =>
      normalizeTaskList([
        { id: 'a', title: 'x', kind: 'read' },
        { id: 'a', title: 'y', kind: 'read' },
      ]),
    /两项都叫 a/,
  );
  assert.throws(() => normalizeTaskList([{ id: 'a', title: '', kind: 'read' }]), /需要标题/);
  assert.throws(() => normalizeTaskList([{ id: 'a', title: 'x', kind: 'maybe' }]), /read 或 write/);
  assert.throws(
    () => normalizeTaskList(Array.from({ length: 31 }, (_, i) => ({ id: `${i}`, title: 'x', kind: 'read' }))),
    /最多 30 项/,
  );
});

test('each item takes its state from the latest member working on it, never from the coordinator', () => {
  const members = [
    { workflow: task('m1', 'root', { status: 'failed', createdAt: '2026-10-10T08:01:00Z' }) },
    { workflow: task('m2', 'root', { status: 'running', createdAt: '2026-10-10T08:02:00Z' }) },
    { workflow: task('m3', 'root', { status: 'waiting-resource' }) },
  ];
  members[0]!.workflow.delegation!.planItem = 'write';
  members[1]!.workflow.delegation!.planItem = 'write';
  members[2]!.workflow.delegation!.planItem = 'tests';
  const progress = taskListProgress(items, members);
  assert.deepEqual(
    progress.map((item) => [item.id, item.state, item.member?.workflow.id]),
    [
      ['read', 'queued', undefined],
      ['write', 'running', 'm2'],
      ['tests', 'queued', 'm3'],
      ['self', 'done', undefined],
    ],
  );
  members[1]!.workflow.status = 'completed';
  members[2]!.workflow.status = 'cancelled';
  assert.deepEqual(
    taskListProgress(items, members).map((item) => item.state),
    ['queued', 'done', 'failed', 'done'],
  );
});

function fixture(t: TestContext, records: Workflow[]) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'project', '', { id: 'project', path: 'C:/synthetic/plan' });
  store.save('conversation', 'conversation', 'project', { id: 'conversation', projectId: 'project', swarm: true });
  for (const workflow of records) store.save('workflow', workflow.id, workflow.conversationId, workflow);
  const active = new Map(
    records
      .filter((workflow) => workflow.status === 'running')
      .map((workflow) => [workflow.id, { abort: new AbortController(), pendingStart: false, workflow }]),
  );
  const captured: Array<{ input: MessageInput; delegation?: Workflow['delegation'] }> = [];
  const controller = {
    targets: [
      { id: 'codex-b', provider: 'codex', label: 'Codex B', enabled: true, environment: 'native', command: 'unused' },
    ],
    snapshots: [],
    settings: {},
    activeRunFor: (id: string) => (active.has(id) ? `run-${id}` : undefined),
    recordRunEvent: () => {},
    broadcast: () => {},
    run: () => undefined,
  };
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, {
    store,
    controller,
    active,
    notices: new Map(),
    memoryExports: { schedule() {} },
    clock: () => Date.parse('2026-10-10T09:00:00Z'),
    requireConversation: (id: string) => store.get('conversation', id),
    requireProject: (id: string) => store.get('project', id),
    wake: () => {},
    send: async (
      conversationId: string,
      input: MessageInput,
      _previous?: string,
      delegation?: Workflow['delegation'],
    ) => {
      captured.push({ input, delegation });
      const workflow = task(`created-${captured.length}`, undefined, {
        input,
        status: 'queued',
        runIds: [],
        delegation,
        createdAt: `2026-10-10T09:00:0${captured.length}Z`,
      });
      store.save('workflow', workflow.id, conversationId, workflow);
      return { workflow };
    },
  });
  const bridge = Object.create(AgentBridge.prototype) as AgentBridge;
  Object.assign(bridge, { workspace, controller, questions: new Map(), awaited: new Map() });
  const caller = {
    run: { id: 'run-root', workflowId: 'root' },
    target: controller.targets[0],
    delegate: true,
    child: false,
    recycle: false,
    write: true,
    signal: new AbortController().signal,
  };
  const internal = bridge as unknown as {
    message(caller: unknown, request: unknown): Promise<any>;
    call(caller: unknown, name: string, args: Record<string, unknown>): Promise<any>;
    results: (...args: unknown[]) => Promise<string[]>;
  };
  internal.results = async () => [];
  return { workspace, store, captured, internal, caller };
}

test('set_plan is offered to a swarm coordinator, saved on its task and echoed with each item’s state', async (t) => {
  const f = fixture(t, [task('root')]);
  const listed = await f.internal.message(f.caller, { id: 1, method: 'tools/list' });
  const names = listed.result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes('set_plan') && names.includes('delegate_many'));
  const member = await f.internal.message(
    { ...f.caller, delegate: false, child: true },
    { id: 2, method: 'tools/list' },
  );
  assert.ok(
    !member.result.tools.some((tool: { name: string }) => tool.name === 'set_plan'),
    'members get no plan tool',
  );
  const reply = await f.internal.call(f.caller, 'set_plan', { items });
  assert.match(reply, /已记下任务清单/);
  assert.match(reply, /- \[排队\] read：读现有路由代码（只读 · 打算交给 自动选择）/);
  assert.match(reply, /- \[完成\] self：自己核对设计文档/);
  const saved = f.store.get<Workflow>('workflow', 'root')!;
  assert.deepEqual(saved.taskList?.items, items);
  await assert.rejects(
    f.internal.call(f.caller, 'set_plan', { items: [{ id: 'x', title: 'y', kind: 'other' }] }),
    /read 或 write/,
  );
  assert.deepEqual(f.store.get<Workflow>('workflow', 'root')!.taskList?.items, items, 'a refused list changes nothing');
  const ordinary = task('ordinary', undefined, { conversationId: 'conversation' });
  ordinary.input.swarm = false;
  f.store.save('workflow', ordinary.id, ordinary.conversationId, ordinary);
  f.workspace.setTaskList('ordinary', items);
  assert.deepEqual(f.store.get<Workflow>('workflow', ordinary.id)?.taskList?.items, items);
  assert.equal(
    f.store.get<Workflow>('workflow', ordinary.id)?.input.swarm,
    false,
    'an optional list does not enable swarm mode',
  );
});

test('outside swarm mode only the root task gets set_plan', async (t) => {
  const root = task('root');
  const child = task('child', 'root');
  root.input.swarm = child.input.swarm = false;
  const f = fixture(t, [root, child]);
  const tools = async (caller: unknown) =>
    ((await f.internal.message(caller, { id: 1, method: 'tools/list' })).result.tools as { name: string }[]).map(
      (tool) => tool.name,
    );
  assert.ok((await tools(f.caller)).includes('set_plan'));
  const childCaller = { ...f.caller, run: { id: 'run-child', workflowId: 'child' }, child: true };
  assert.ok((await tools(childCaller)).includes('delegate'), 'the child may still delegate');
  assert.ok(!(await tools(childCaller)).includes('set_plan'));
  await assert.rejects(f.internal.call(childCaller, 'set_plan', { items }), /任务清单/);
  assert.equal(f.store.get<Workflow>('workflow', 'child')!.taskList, undefined);
  assert.match(await f.internal.call(f.caller, 'set_plan', { items }), /对话顶部/);
});

test('delegating with a plan_id links the member, adds an id the list lacks, and names automatic members in turn', async (t) => {
  const f = fixture(t, [task('root', undefined, { taskList: { items, updatedAt: at } })]);
  await f.internal.call(f.caller, 'delegate', { task: 'Read the routing code', plan_id: 'read', tier: 'standard' });
  await f.internal.call(f.caller, 'delegate', { task: 'Check the docs', plan_id: 'docs' });
  await f.internal.call(f.caller, 'delegate', { agent: 'Codex B', task: 'Rewrite the allocation', plan_id: 'write' });
  assert.deepEqual(
    f.captured.map(({ delegation }) => [delegation?.agent?.label, delegation?.planItem, delegation?.suggestedTier]),
    [
      ['成员 1', 'read', 'standard'],
      ['成员 2', 'docs', undefined],
      ['Codex B', 'write', undefined],
    ],
  );
  assert.equal(f.captured[0]!.input.provider, undefined, 'PugPort chooses the executor');
  assert.equal(f.captured[0]!.input.runtimeId, undefined);
  assert.match(f.captured[0]!.input.content, /最后一段以「结论：」开头/);
  const list = f.store.get<Workflow>('workflow', 'root')!.taskList!.items;
  assert.deepEqual(list.at(-1), { id: 'docs', title: 'Check the docs', kind: 'read' });
  await assert.rejects(f.internal.call(f.caller, 'delegate', { task: 'x', tier: 'huge' }), /tier 只能是/);
  const listed = await f.internal.call(f.caller, 'list_swarm', {});
  assert.match(listed.plan, /- \[排队\] read：读现有路由代码（只读 · 成员 1，task_id: created-1）/);
});

const members = (records: Workflow[], runs: RunRecord[]) =>
  swarmMembers(records, runs, [{ id: 'codex-b', label: 'Codex B' }] as never);
const run = (workflowId: string, start: string, end?: string): RunRecord => ({
  id: `run-${workflowId}`,
  workflowId,
  prompt: '',
  projectPath: 'C:/synthetic',
  kind: 'general',
  status: end ? 'completed' : 'running',
  route: { runtimeId: 'codex-b', model: 'gpt-6-sol', effort: 'low', kind: 'general', reasons: [], warnings: [] },
  startedAt: start,
  ...(end ? { endedAt: end } : {}),
  output: '',
  events: [],
});

test('the group chat shows the coordinator’s list above the members, with state and who is on each item', () => {
  const root = task('root', undefined, { taskList: { items, updatedAt: at } });
  const reader = task('reader', 'root', { status: 'completed' });
  reader.delegation!.planItem = 'read';
  const writer = task('writer', 'root', { runIds: [] });
  writer.delegation!.planItem = 'write';
  const records = [root, reader, writer];
  const view = members(records, [run('reader', at, '2026-10-10T08:05:00Z')]);
  const plan = swarmPlan(records, view)!;
  assert.deepEqual(
    plan.rows.map((row) => [row.id, row.state, row.who]),
    [
      ['read', 'done', 'Codex B'],
      ['write', 'running', 'Agent writer'],
      ['tests', 'queued', undefined],
      ['self', 'done', undefined],
    ],
  );
  assert.equal(plan.done, 2);
  assert.deepEqual(JSON.parse(plan.scope), ['project', 'conversation', 'root', 'root']);
  const html = renderToStaticMarkup(createElement(SwarmPlanPanel, { plan, saved: '并行省了约 12 分钟' }));
  assert.match(html, /任务清单/);
  assert.match(html, /2\/4 完成/);
  assert.match(html, /并行省了约 12 分钟/);
  // Who is on an item is a name: shown as written, after the translated interface text.
  assert.match(
    html,
    /class="swarm-plan-item done"[\s\S]*完成[\s\S]*读现有路由代码[\s\S]*只读 · <span translate="no">Codex B</,
  );
  assert.match(html, /进行中[\s\S]*改写分配逻辑[\s\S]*改文件 · <span translate="no">Agent writer</);
  assert.match(html, /排队[\s\S]*补测试/);
  assert.equal((html.match(/aria-label="隐藏任务：/g) ?? []).length, 2, 'only finished rows can be hidden');
  assert.doesNotMatch(html, /aria-label="隐藏任务：(?:改写分配逻辑|补测试)"/, 'active tasks remain visible');
  const page = renderToStaticMarkup(
    createElement(SwarmWorkspaceView, {
      members: view,
      communications: [],
      messages: [],
      loading: false,
      sending: false,
      draft: '',
      plan,
      onSelect() {},
      onDraft() {},
      onSend() {},
      onInspect() {},
    }),
  );
  assert.ok(page.indexOf('swarm-bar') < page.indexOf('swarm-plan'), 'the list sits right under the member strip');
  assert.equal(swarmPlan([task('root')], members([task('root')], [])), undefined, 'no list, no panel');
  // A continuation of the coordinator keeps showing the list it wrote earlier.
  const continued = task('root-2', undefined, { parentWorkflowId: 'root', createdAt: '2026-10-10T09:00:00Z' });
  assert.equal(swarmPlan([...records, continued], members([...records, continued], []))?.rows.length, 4);
});

test('a finished swarm says how much time running members side by side saved', () => {
  assert.deepEqual(
    swarmTimeSaved([
      { startedAt: '2026-10-10T08:00:00Z', endedAt: '2026-10-10T08:10:00Z' },
      { startedAt: '2026-10-10T08:00:00Z', endedAt: '2026-10-10T08:08:00Z' },
      { startedAt: '2026-10-10T08:02:00Z', endedAt: '2026-10-10T08:12:00Z' },
    ]),
    { savedMs: 16 * 60_000, totalMs: 28 * 60_000, spanMs: 12 * 60_000 },
  );
  assert.equal(
    swarmTimeSaved([
      { startedAt: '2026-10-10T08:00:00Z', endedAt: '2026-10-10T08:10:00Z' },
      { startedAt: '2026-10-10T08:10:00Z', endedAt: '2026-10-10T08:20:00Z' },
    ])?.savedMs,
    0,
    'one after another saves nothing',
  );
  assert.equal(
    swarmTimeSaved([{ startedAt: '2026-10-10T08:00:00Z' }, { startedAt: '2026-10-10T08:00:00Z' }]),
    undefined,
  );
  assert.equal(savedTimeText(20_000), undefined);
  // Whole sentences, so the English window translates each in one piece.
  assert.equal(savedTimeText(12 * 60_000), '并行省了约 12 分钟');
  assert.equal(savedTimeText(65 * 60_000), '并行省了约 1 小时 5 分钟');
  assert.equal(savedTimeText(120 * 60_000), '并行省了约 2 小时');
  // Only members that did their own work count; the coordinator and a member that handed work on mostly waited.
  const root = task('root', undefined, { status: 'completed' });
  const lead = task('lead', 'root', { status: 'completed' });
  const a = task('a', 'lead', { status: 'completed' });
  const b = task('b', 'root', { status: 'completed' });
  const records = [root, lead, a, b];
  const runs = [
    run('root', '2026-10-10T08:00:00Z', '2026-10-10T08:30:00Z'),
    run('lead', '2026-10-10T08:01:00Z', '2026-10-10T08:20:00Z'),
    run('a', '2026-10-10T08:02:00Z', '2026-10-10T08:12:00Z'),
    run('b', '2026-10-10T08:02:00Z', '2026-10-10T08:14:00Z'),
  ];
  assert.equal(swarmSavedTime(members(records, runs), runs)?.savedMs, 10 * 60_000);
  const busy = records.map((workflow) =>
    workflow.id === 'root' ? { ...workflow, status: 'running' as const } : workflow,
  );
  assert.equal(swarmSavedTime(members(busy, runs), runs), undefined, 'only once the swarm has finished');
  const html = renderToStaticMarkup(
    createElement(SwarmWorkspaceView, {
      members: members(records, runs),
      communications: [],
      messages: [],
      loading: false,
      sending: false,
      draft: '',
      saved: '并行省了约 10 分钟',
      onSelect() {},
      onDraft() {},
      onSend() {},
      onInspect() {},
    }),
  );
  assert.match(html, /成员与任务[\s\S]*4 位成员/, 'a finished swarm keeps its details behind one small restore entry');
  assert.doesNotMatch(html, /swarm-bar|并行省了/, 'historical task details do not stay open by default');
});
