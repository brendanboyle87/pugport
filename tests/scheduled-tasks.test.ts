import { machineLoadReasons } from '../src/shared/machine-load.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { ScheduledTasks, nextRunAt, routineSchema } from '../src/server/scheduled-tasks.ts';
import type { Routine, RoutineInput } from '../src/shared/scheduled-tasks.ts';
import type { Conversation, MessageInput, Project, Workflow } from '../src/shared/types.ts';
import type { Workspace } from '../src/server/workspace.ts';
import { fixture as realFixture } from './helpers/session-workspace.ts';
import express from 'express';
import { scheduledTaskRoutes } from '../src/server/scheduled-task-routes.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const input: RoutineInput = {
  name: 'Daily review',
  prompt: 'Summarize the synthetic project.',
  schedule: { type: 'daily', time: '09:00' },
  permissionMode: 'read-only',
};
// Synthetic project folders that are absolute on the machine running the test.
const source = process.platform === 'win32' ? 'C:/source' : '/source';
const otherSource = process.platform === 'win32' ? 'C:/other-source' : '/other-source';
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  let now = new Date('2026-01-05T12:00:00Z');
  let count = 0;
  const sent: { input: MessageInput; options: unknown }[] = [];
  const projects: string[] = [];
  const conversations: Conversation[] = [];
  const conversation = (projectId: string, title = '') => {
    const value = { id: `conversation-${++count}`, projectId, title } as Conversation;
    conversations.push(value);
    store.save('conversation', value.id, projectId, value);
    return value;
  };
  const durableStore = Object.assign(Object.create(Store.prototype) as Store, { db });
  const workspace = {
    store,
    controller: { store: durableStore },
    createProject: async (path: string) => {
      projects.push(path);
      const project = { id: 'project', path } as Project;
      store.save('project', project.id, project.id, project);
      return project;
    },
    createConversation: conversation,
    createGeneralConversation: async (title = '') => {
      store.save('project', 'general', 'general', { id: 'general', scope: 'chat' });
      return conversation('general', title);
    },
    cancel: (id: string) => {
      const workflow = store.get<Workflow>('workflow', id)!;
      store.save('workflow', id, workflow.conversationId, { ...workflow, status: 'cancelled' });
    },
    send: async (id: string, body: MessageInput, _parent?: string, _delegation?: unknown, options?: unknown) => {
      sent.push({ input: body, options });
      const workflow = {
        id: `workflow-${sent.length}`,
        conversationId: id,
        status: 'queued',
        runIds: [],
      } as unknown as Workflow;
      store.save('workflow', workflow.id, id, workflow);
      return { workflow };
    },
  } as unknown as Pick<
    Workspace,
    'store' | 'controller' | 'send' | 'createProject' | 'createConversation' | 'createGeneralConversation' | 'cancel'
  >;
  const tasks = new ScheduledTasks(workspace, () => now);
  t.after(async () => {
    await tasks.close();
    db.close();
  });
  const finish = (id: string, status: Workflow['status'] = 'completed') => {
    const workflow = store.get<Workflow>('workflow', id)!;
    store.save('workflow', id, workflow.conversationId, { ...workflow, status });
  };
  return {
    tasks,
    workspace,
    sent,
    projects,
    conversations,
    finish,
    time: (value: string) => (now = new Date(value)),
    restart: () => new ScheduledTasks(workspace, () => now),
  };
}

test('calendar schedules use local dates, strict next occurrence and weekday boundaries', () => {
  const start = new Date(2026, 0, 9, 10); // Friday
  assert.equal(nextRunAt({ type: 'daily', time: '09:00' }, start), new Date(2026, 0, 10, 9).toISOString());
  assert.equal(nextRunAt({ type: 'weekdays', time: '09:00' }, start), new Date(2026, 0, 12, 9).toISOString());
  assert.equal(
    nextRunAt({ type: 'weekly', weekday: 5, time: '10:00' }, start),
    new Date(2026, 0, 16, 10).toISOString(),
  );
  assert.equal(nextRunAt({ type: 'interval', hours: 3 }, start), new Date(+start + 10800000).toISOString());
});

test('DST spring gap advances, autumn fold runs once, intervals remain elapsed hours', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.equal(
      nextRunAt({ type: 'daily', time: '02:30' }, new Date('2026-03-08T05:00Z')),
      '2026-03-08T07:30:00.000Z',
    );
    assert.equal(
      nextRunAt({ type: 'daily', time: '02:30' }, new Date('2026-03-08T07:30Z')),
      '2026-03-09T06:30:00.000Z',
    );
    assert.equal(
      nextRunAt({ type: 'weekdays', time: '09:00' }, new Date('2026-03-06T15:00Z')),
      '2026-03-09T13:00:00.000Z',
    );
    assert.equal(
      nextRunAt({ type: 'weekly', weekday: 0, time: '09:00' }, new Date('2026-03-01T15:00Z')),
      '2026-03-08T13:00:00.000Z',
    );
    assert.equal(
      nextRunAt({ type: 'daily', time: '01:30' }, new Date('2026-11-01T04:00Z')),
      '2026-11-01T05:30:00.000Z',
    );
    assert.equal(
      nextRunAt({ type: 'daily', time: '01:30' }, new Date('2026-11-01T05:30Z')),
      '2026-11-02T06:30:00.000Z',
    );
    for (const start of ['2026-03-08T06:30Z', '2026-11-01T05:30Z'])
      assert.equal(Date.parse(nextRunAt({ type: 'interval', hours: 2 }, new Date(start))) - Date.parse(start), 7200000);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('new routines are paused, validated, persisted and editable without silently enabling', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  assert.equal(routine.enabled, false);
  f.time('2026-02-01T12:00Z');
  await f.tasks.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.tasks.update(routine.id, { ...input, name: 'Renamed' }).enabled, false);
  assert.equal(f.restart().get(routine.id).name, 'Renamed');
  for (const schedule of [
    { type: 'daily', time: '25:00' },
    { type: 'interval', hours: 0 },
    { type: 'weekly', weekday: 7, time: '09:00' },
  ])
    assert.equal(routineSchema.safeParse({ ...input, schedule }).success, false);
  assert.equal(routineSchema.safeParse({ ...input, permissionMode: 'workspace-write' }).success, false);
  assert.equal(routineSchema.safeParse({ ...input, enabled: true }).success, false);
  f.tasks.remove(routine.id);
  assert.equal(f.tasks.list().length, 0);
});

test('a previously bound routine never recreates a removed or purged project from its old path', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create({ ...input, projectPath: source });
  const first = await f.tasks.runNow(routine.id);
  f.finish(first.history.at(-1)!.workflowId);
  const projectId = f.tasks.get(routine.id).projectId!;
  f.workspace.store.db.prepare("DELETE FROM workspace_records WHERE kind='project' AND id=?").run(projectId);
  const afterPurge = await f.tasks.runNow(routine.id);
  assert.equal(afterPurge.history.at(-1)?.status, 'failed');
  assert.match(afterPurge.history.at(-1)?.reason ?? '', /重新选择项目/);
  assert.deepEqual(f.projects, [source]);
  assert.equal(f.sent.length, 1);
  f.workspace.store.save('project', projectId, projectId, {
    id: projectId,
    path: source,
    removedAt: '2026-10-25',
  });
  const removed = await f.tasks.runNow(routine.id);
  assert.equal(removed.history.at(-1)?.status, 'failed');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.projects, [source]);
});

test('an explicitly changed routine project path can establish a new binding after the previous project was purged', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create({ ...input, projectPath: source });
  const first = await f.tasks.runNow(routine.id);
  f.finish(first.history.at(-1)!.workflowId);
  const old = f.tasks.get(routine.id).projectId!;
  f.workspace.store.db.prepare("DELETE FROM workspace_records WHERE kind='project' AND id=?").run(old);
  f.tasks.update(routine.id, { ...input, projectPath: otherSource });
  const changed = await f.tasks.runNow(routine.id);
  assert.equal(changed.history.at(-1)?.status, 'queued');
  assert.deepEqual(f.projects, [source, otherSource]);
  assert.equal(f.sent.length, 2);
});

test('a purge pause saved during an outstanding project lookup prevents conversation creation and dispatch', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create({ ...input, projectPath: source });
  f.tasks.setEnabled(routine.id, true);
  const create = f.workspace.createProject;
  let release!: () => void;
  f.workspace.createProject = async (path) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return create(path);
  };
  const pending = f.tasks.runNow(routine.id);
  assert.ok(release);
  const stored = f.workspace.store.get<Routine>('routine', routine.id)!;
  f.workspace.store.save('routine', routine.id, routine.id, { ...stored, enabled: false });
  release();
  const result = await pending;
  assert.equal(result.history.at(-1)?.status, 'cancelled');
  assert.equal(f.sent.length, 0);
  assert.equal(f.conversations.length, 0);
  assert.equal(f.tasks.get(routine.id).enabled, false);
});

test('due tick starts once; several missed days catch up once, including after restart', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  f.tasks.setEnabled(routine.id, true);
  f.time('2026-02-01T20:00Z');
  await Promise.all([f.tasks.tick(), f.tasks.tick(), f.tasks.tick()]);
  assert.equal(f.sent.length, 1);
  f.finish('workflow-1');
  await f.restart().tick();
  assert.equal(f.sent.length, 1);
  assert.ok(Date.parse(f.tasks.get(routine.id).nextRunAt) > Date.parse('2026-02-01T20:00Z'));
  assert.match(f.conversations[0].title, /^Daily review · 2026-02-01$/);
  assert.equal(f.conversations[0].projectId, 'general');
});

test('queued, running and awaiting-confirmation instances never overlap; history follows workflow', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  f.tasks.setEnabled(routine.id, true);
  await f.tasks.runNow(routine.id);
  for (const status of ['queued', 'running', 'waiting-resource', 'waiting-confirmation', 'waiting-approval'] as const) {
    f.finish('workflow-1', status);
    f.time('2026-03-01T20:00Z');
    await f.tasks.tick();
    await assert.rejects(f.tasks.runNow(routine.id), /上一次运行还没结束/);
    assert.equal(f.sent.length, 1);
    assert.equal(f.tasks.get(routine.id).history[0].status, status);
  }
  f.finish('workflow-1');
  await f.tasks.tick();
  assert.equal(f.sent.length, 2);
  await f.tasks.tick();
  assert.equal(f.sent.length, 2);
});

test('manual run works paused; resume skips deliberately paused windows and preserves settings', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create({
    ...input,
    permissionMode: 'workspace-write',
    projectPath: process.cwd(),
    executor: 'card',
    model: 'model',
    effort: 'high',
  });
  await f.tasks.runNow(routine.id);
  assert.equal(f.tasks.get(routine.id).enabled, false);
  assert.deepEqual(f.sent[0].options, { unattended: true });
  assert.equal(f.sent[0].input.runtimeId, 'card');
  assert.equal(f.sent[0].input.model, 'model');
  assert.equal(f.sent[0].input.effort, 'high');
  assert.equal(f.sent[0].input.explicitWrite, true);
  // Write permission lets a routine change files; it does not make every run a file task.
  assert.equal(f.sent[0].input.expectsFileChanges, undefined);
  assert.deepEqual(f.projects, [process.cwd()]);
  f.finish('workflow-1');
  f.time('2026-03-01T20:00Z');
  f.tasks.setEnabled(routine.id, true);
  await f.tasks.tick();
  assert.equal(f.sent.length, 1);
  f.tasks.setEnabled(routine.id, false);
  f.time('2026-04-01T20:00Z');
  await f.tasks.tick();
  assert.equal(f.sent.length, 1);
});

test('in-flight dispatch rejects manual clicks, preserves edits and cancels on pause', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  let release!: () => void;
  const send = f.workspace.send;
  f.workspace.send = async (...args) => {
    await new Promise<void>((resolve) => (release = resolve));
    return send(...args);
  };
  const first = f.tasks.runNow(routine.id);
  await assert.rejects(f.tasks.runNow(routine.id), /上一次运行还没结束/);
  await Promise.resolve();
  f.tasks.update(routine.id, { ...input, name: 'Edited during launch' });
  f.tasks.setEnabled(routine.id, false);
  release();
  await first;
  assert.equal(f.tasks.get(routine.id).name, 'Edited during launch');
  assert.equal(f.tasks.get(routine.id).enabled, false);
  assert.equal(f.sent.length, 1);
  assert.equal(f.tasks.get(routine.id).history.at(-1)?.status, 'cancelled');
});

test('pause then resume keeps an in-flight starting run', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  f.tasks.setEnabled(routine.id, true);
  const create = f.workspace.createGeneralConversation;
  let release!: () => void;
  f.workspace.createGeneralConversation = async (title) => {
    await new Promise<void>((resolve) => (release = resolve));
    return create(title);
  };
  const pending = f.tasks.runNow(routine.id);
  assert.equal(f.tasks.get(routine.id).history[0].status, 'starting');
  f.tasks.setEnabled(routine.id, false);
  f.tasks.setEnabled(routine.id, true);
  release();
  await pending;
  assert.equal(f.sent.length, 1);
  assert.equal(f.tasks.get(routine.id).history[0].status, 'queued');
  assert.equal(f.tasks.get(routine.id).enabled, true);
});

test('crash recovery picks the earliest matching workflow in a shared conversation', (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  const at = '2026-01-05T12:00:00.000Z';
  const workflows = [
    { id: 'later-user', createdAt: '2026-01-05T12:02:00.000Z', status: 'running' },
    { id: 'routine-run', createdAt: at, status: 'completed' },
    { id: 'older', createdAt: '2026-01-05T11:59:00.000Z', status: 'failed' },
  ] as Workflow[];
  const lookup = t.mock.method(f.workspace.store, 'workflows', () => workflows);
  f.workspace.store.save('routine', routine.id, routine.id, {
    ...routine,
    history: [{ at, workflowId: '', conversationId: 'shared', status: 'starting' }],
  });
  const recovered = f.restart().get(routine.id).history[0];
  assert.equal(lookup.mock.calls[0].arguments[0], 'shared');
  assert.equal(recovered.workflowId, 'routine-run');
  assert.equal(recovered.status, 'completed');
  assert.equal(f.workspace.store.get<Routine>('routine', routine.id)!.history[0].workflowId, 'routine-run');
});

test('failed launches are recorded and consumed; last 50 runs retained', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  f.workspace.createGeneralConversation = async () => {
    throw new Error('Synthetic unavailable folder');
  };
  f.tasks.setEnabled(routine.id, true);
  for (let day = 1; day <= 55; day++) {
    f.time(new Date(Date.UTC(2026, 1, day, 20)).toISOString());
    await f.tasks.tick();
  }
  const history = f.tasks.get(routine.id).history;
  assert.equal(history.length, 50);
  assert.ok(history.every((run) => run.status === 'failed' && run.reason === 'Synthetic unavailable folder'));
  await f.tasks.tick();
  assert.deepEqual(f.tasks.get(routine.id).history, history);
});

test('real send path queues a busy machine with CPU reason and no prompt, even when idle', async (t) => {
  const { workspace, controller, directory } = realFixture(t);
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    cpuPercent: 92,
    availableMemoryBytes: 8 * 1024 ** 3,
  }));
  const tasks = new ScheduledTasks(workspace);
  const routine = tasks.create({ ...input, projectPath: directory, executor: 'mock' });
  const result = await tasks.runNow(routine.id);
  await workspace.tickQueue();
  const workflow = workspace.store.get<Workflow>('workflow', result.history[0].workflowId)!;
  assert.equal(workflow.status, 'waiting-resource');
  assert.equal(workflow.machineLoadChoice, 'wait');
  assert.equal(workflow.scheduling!.reason, machineLoadReasons.cpu);
  assert.equal(workflow.runIds.length, 0);
  assert.equal(workflow.input.permissionMode, 'read-only');
  await tasks.close();
});

test('HTTP routes create, edit, pause, resume, run and delete with validation', async (t) => {
  const f = fixture(t);
  const app = express();
  app.use(express.json());
  scheduledTaskRoutes(app, f.tasks);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(400).json({ error: error.message }),
  );
  const server = await listenForFetch(app);
  t.after(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  );
  const address = server.address() as { port: number };
  const request = (suffix = '', method = 'GET', body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/scheduled-tasks${suffix}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const created = await request('', 'POST', input);
  assert.equal(created.status, 201);
  const routine = (await created.json()) as { id: string; enabled: boolean };
  assert.equal(routine.enabled, false);
  assert.equal(((await (await request()).json()) as unknown[]).length, 1);
  assert.equal((await request(`/${routine.id}`, 'PUT', { ...input, name: 'Changed' })).status, 200);
  assert.equal((await request(`/${routine.id}`, 'PATCH', { enabled: true })).status, 200);
  assert.equal((await request(`/${routine.id}`, 'PATCH', { enabled: false })).status, 200);
  assert.equal((await request(`/${routine.id}/run`, 'POST', {})).status, 200);
  assert.equal(f.sent.length, 1);
  assert.equal((await request('', 'POST', { ...input, permissionMode: 'workspace-write' })).status, 400);
  assert.equal((await request(`/${routine.id}`, 'DELETE')).status, 200);
  assert.equal(((await (await request()).json()) as unknown[]).length, 0);
  assert.ok(f.workspace.store.get('workflow', 'workflow-1'), 'deleting a routine preserves its conversation workflow');
});

test('minute timer is unrefed and stops cleanly; immediate completed runs can share a clock instant', async (t) => {
  const f = fixture(t);
  const intervals: number[] = [];
  let unrefed = false;
  let stopped = false;
  t.mock.method(globalThis, 'setInterval', (_callback: () => void, delay: number) => {
    intervals.push(delay);
    return { unref: () => (unrefed = true) };
  });
  t.mock.method(globalThis, 'clearInterval', () => (stopped = true));
  f.tasks.start();
  f.tasks.start();
  assert.deepEqual(intervals, [60000]);
  assert.equal(unrefed, true);
  const routine = f.tasks.create(input);
  await f.tasks.runNow(routine.id);
  f.finish('workflow-1');
  await f.tasks.runNow(routine.id);
  f.finish('workflow-2');
  assert.deepEqual(
    f.tasks.get(routine.id).history.map((run) => run.workflowId),
    ['workflow-1', 'workflow-2'],
  );
  await f.tasks.close();
  assert.equal(stopped, true);
  await assert.rejects(f.tasks.runNow(routine.id));
});

test('routine reservation commits with FULL before dispatch and returns to NORMAL', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  const save = f.workspace.store.save.bind(f.workspace.store);
  let committed = false;
  t.mock.method(f.workspace.store, 'save', (...args: Parameters<typeof save>) => {
    if (args[0] === 'routine' && (args[3] as { history: { status: string }[] }).history.at(-1)?.status === 'starting') {
      assert.equal(f.workspace.store.db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
      committed = true;
    }
    return save(...args);
  });
  const send = f.workspace.send.bind(f.workspace);
  t.mock.method(f.workspace, 'send', (...args: Parameters<typeof send>) => {
    assert.ok(committed);
    assert.equal(f.workspace.store.db.prepare('PRAGMA synchronous').get()!.synchronous, 1);
    return send(...args);
  });
  await f.tasks.runNow(routine.id);
  assert.ok(committed);
});

test('runs reuse a local-day conversation across restart and replace deleted conversations in the same project', async (t) => {
  const f = fixture(t);
  f.time(new Date(2026, 0, 5, 12).toISOString());
  const general = t.mock.method(f.workspace, 'createGeneralConversation');
  const routine = f.tasks.create(input);
  const first = await f.tasks.runNow(routine.id);
  f.finish('workflow-1');
  const second = await f.restart().runNow(routine.id);
  assert.equal(second.lastConversationId, first.lastConversationId);
  assert.equal(f.conversations.length, 1);
  assert.equal(f.sent[1].input.queue, true);
  f.finish('workflow-2');
  f.time(new Date(2026, 0, 6, 0, 1).toISOString());
  const third = await f.tasks.runNow(routine.id);
  assert.notEqual(third.lastConversationId, first.lastConversationId);
  f.finish('workflow-3');
  f.workspace.store.deleteConversation(third.lastConversationId!);
  const fourth = await f.tasks.runNow(routine.id);
  assert.notEqual(fourth.lastConversationId, third.lastConversationId);
  assert.equal(fourth.projectId, first.projectId);
  assert.equal(f.conversations.length, 3);
  assert.equal(general.mock.callCount(), 1);
  assert.equal(f.workspace.store.projects(true).length, 1);
});

test('changing project path resets conversation reuse', async (t) => {
  const f = fixture(t);
  const routine = await f.tasks.runNow(f.tasks.create(input).id);
  f.finish('workflow-1');
  f.tasks.update(routine.id, { ...input, projectPath: process.cwd() });
  const changed = await f.tasks.runNow(routine.id);
  assert.notEqual(changed.lastConversationId, routine.lastConversationId);
  assert.equal(changed.projectId, 'project');
});

test('removed projects fail scheduled runs without restoring or creating empty conversations', async (t) => {
  const { workspace, directory } = realFixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  workspace.removeProject(project.id);
  const tasks = new ScheduledTasks(workspace);
  t.after(() => tasks.close());
  const routine = tasks.create({ ...input, projectPath: directory });
  const failed = await tasks.runNow(routine.id);
  assert.equal(failed.history[0].status, 'failed');
  assert.equal(failed.history[0].reason, '项目已从列表移除');
  assert.ok(workspace.store.get<Project>('project', project.id)?.removedAt);
  assert.equal(workspace.store.list('conversation').length, 1);
  assert.ok(workspace.store.get<Conversation>('conversation', conversation.id)?.deletedAt);
  assert.equal(workspace.store.workflows().length, 0);
});

test('pausing or deleting cancels unstarted runs but preserves started runs', async (t) => {
  const f = fixture(t);
  for (const status of ['queued', 'waiting-resource', 'running'] as const) {
    for (const remove of [false, true]) {
      const routine = await f.tasks.runNow(f.tasks.create(input).id);
      const id = routine.history[0].workflowId;
      f.finish(id, status);
      if (remove) f.tasks.remove(routine.id);
      else f.tasks.setEnabled(routine.id, false);
      assert.equal(
        f.workspace.store.get<Workflow>('workflow', id)?.status,
        status === 'running' ? status : 'cancelled',
      );
    }
  }
});

test('deletion during conversation creation stops dispatch and never recreates the routine', async (t) => {
  const f = fixture(t);
  const routine = f.tasks.create(input);
  const create = f.workspace.createGeneralConversation;
  let release!: () => void;
  f.workspace.createGeneralConversation = async (title) => {
    await new Promise<void>((resolve) => (release = resolve));
    return create(title);
  };
  const pending = f.tasks.runNow(routine.id);
  f.tasks.remove(routine.id);
  release();
  await pending;
  assert.equal(f.sent.length, 0);
  assert.equal(f.workspace.store.get('routine', routine.id), undefined);
});

test('clock rollback repairs distant interval and calendar dates; idle ticks only refresh the last workflow', async (t) => {
  const f = fixture(t);
  for (const schedule of [
    { type: 'interval', hours: 2 },
    { type: 'weekly', weekday: 1, time: '09:00' },
  ] as const) {
    f.time('2026-06-01T12:00Z');
    const routine = f.tasks.create({ ...input, schedule });
    f.tasks.setEnabled(routine.id, true);
    f.time('2026-01-05T12:00Z');
    await f.tasks.tick();
    assert.equal(f.tasks.get(routine.id).nextRunAt, nextRunAt(schedule, new Date('2026-01-05T12:00Z')));
    f.tasks.remove(routine.id);
  }
  const routine = f.tasks.create(input);
  const history: Routine['history'] = Array.from({ length: 50 }, (_, i) => ({
    at: '',
    workflowId: `old-${i}`,
    status: 'completed',
  }));
  history[49].status = 'queued';
  f.workspace.store.save('routine', routine.id, routine.id, { ...routine, history });
  const get = t.mock.method(f.workspace.store, 'get');
  const list = t.mock.method(f.workspace.store, 'list');
  await f.tasks.tick();
  assert.equal(list.mock.calls.filter((call) => call.arguments[0] === 'routine').length, 1);
  assert.deepEqual(
    get.mock.calls.filter((call) => call.arguments[0] === 'workflow').map((call) => call.arguments[1]),
    ['old-49'],
  );
});

test('scheduled and manual routine runs skip route confirmation while ordinary sends still require it', async (t) => {
  const { workspace, controller, directory } = realFixture(t);
  controller.settings.decisionMode = 'confirm';
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    cpuPercent: 92,
    availableMemoryBytes: 8 * 1024 ** 3,
  }));
  let now = new Date('2026-01-05T12:00Z');
  const tasks = new ScheduledTasks(workspace, () => now);
  t.after(() => tasks.close());
  const routine = tasks.create({ ...input, projectPath: directory, executor: 'mock' });
  const manual = await tasks.runNow(routine.id);
  const first = workspace.store.get<Workflow>('workflow', manual.history[0].workflowId)!;
  assert.equal(first.requiresConfirmation, false);
  tasks.setEnabled(routine.id, false);
  tasks.setEnabled(routine.id, true);
  now = new Date('2026-01-06T20:00Z');
  await tasks.tick();
  const scheduled = workspace.store.get<Workflow>('workflow', tasks.get(routine.id).history.at(-1)!.workflowId)!;
  assert.equal(scheduled.requiresConfirmation, false);
  assert.equal(scheduled.machineLoadChoice, 'wait');
  const normal = await workspace.send(scheduled.conversationId, { ...scheduled.input, queue: true });
  assert.equal(normal.workflow.requiresConfirmation, true);
});
