import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { AppState, Conversation, MessageInput, Project, Workflow } from '../src/shared/types.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import { fixture, input } from './helpers/session-workspace.ts';

const notStarted = '文件夹已不存在，这个任务没有启动。请重新发送。';
async function setup(t: TestContext, origin?: 'dispatch') {
  const f = fixture(t);
  t.mock.method(f.workspace, 'tickQueue', async () => {});
  const folder = join(f.directory, 'project');
  mkdirSync(folder);
  const project = await f.workspace.createProject(folder, undefined, false, { origin });
  const disappear = () => {
    assert.ok(folder.startsWith(f.directory + sep));
    rmSync(folder, { recursive: true });
  };
  return { ...f, project, folder, disappear };
}

test('manual moving preserves chat history and permits the next send', async (t) => {
  const { workspace, controller, project, disappear } = await setup(t);
  Object.assign(project, {
    trusted: true,
    approvedVerificationCommands: ['synthetic check'],
    localMemory: { exportEnabled: true, cliEnabled: true },
    manuscript: 'old-book',
    rules: ['Keep this rule'],
  });
  workspace.store.save('project', project.id, project.id, project);
  const chat = workspace.createConversation(project.id, 'Keep this chat');
  const message = workspace.store.addMessage(chat.id, 'user', 'Saved synthetic message');
  message.attachments = [{ id: 'attachment', name: 'synthetic.txt', mimeType: 'text/plain', size: 12, kind: 'file' }];
  workspace.store.save('message', message.id, chat.id, message);
  const messages = workspace.store.allMessages(chat.id);
  chat.pinnedMessages = [{ messageId: message.id, pinnedAt: '2026-01-01' }];
  workspace.store.save('conversation', chat.id, project.id, chat);
  const history = { id: 'history', projectId: project.id, conversationId: chat.id, status: 'completed', updatedAt: '' };
  workspace.store.save('workflow', history.id, chat.id, history);
  const before = workspace.state();
  assert.equal(before.projects?.[0].folderMissing, false);
  const broadcasts: Partial<AppState>[] = [];
  t.mock.method(controller, 'broadcast', () => {
    broadcasts.push(workspace.state());
  });
  disappear();
  workspace.refreshProjectFolders();
  const moved = workspace.moveProjectToChats(project.id);
  assert.equal(moved.id, project.id);
  assert.equal(moved.scope, 'chat');
  assert.equal(moved.name, '日常对话');
  assert.ok(moved.path.startsWith(join(realpathSync.native(controller.dataDir), 'workspaces') + sep));
  assert.equal(moved.path, realpathSync.native(moved.path));
  for (const setting of ['trusted', 'approvedVerificationCommands', 'localMemory', 'manuscript', 'origin'] as const)
    assert.equal(moved[setting], undefined);
  assert.deepEqual(moved.rules, project.rules);
  assert.deepEqual(workspace.store.get('conversation', chat.id), chat);
  assert.deepEqual(workspace.store.allMessages(chat.id), messages);
  assert.deepEqual(workspace.store.get('workflow', history.id), history);
  assert.deepEqual(workspace.state().workflows, before.workflows);
  assert.equal(workspace.state().conversations?.[0].id, chat.id);
  assert.equal(workspace.state().conversationMessages?.[0].id, message.id);
  assert.equal(broadcasts.at(-1)?.projects?.[0].scope, 'chat');
  const sent = await workspace.send(chat.id, { ...input, queue: true });
  assert.equal(sent.workflow?.projectId, project.id);
});

test('moving preserves inherited routing as visible chat overrides and clears the project default', async (t) => {
  const { workspace, project, disappear } = await setup(t);
  project.routingProfileId = 'project-profile';
  workspace.store.save('project', project.id, project.id, project);
  const inherited = workspace.createConversation(project.id);
  const automatic = workspace.createConversation(project.id);
  automatic.routingProfileId = null;
  workspace.store.save('conversation', automatic.id, project.id, automatic);
  const override = workspace.createConversation(project.id);
  override.routingProfileId = 'chat-profile';
  workspace.store.save('conversation', override.id, project.id, override);
  disappear();
  workspace.moveProjectToChats(project.id);
  assert.equal(workspace.store.get<Project>('project', project.id)?.routingProfileId, undefined);
  assert.equal(workspace.store.get<Conversation>('conversation', inherited.id)?.routingProfileId, 'project-profile');
  assert.equal(workspace.store.get<Conversation>('conversation', automatic.id)?.routingProfileId, null);
  assert.equal(workspace.store.get<Conversation>('conversation', override.id)?.routingProfileId, 'chat-profile');
});

test('conversion stores the real workspace path even when dataDir is reached through a junction', async (t) => {
  const { workspace, controller, directory, project, disappear } = await setup(t);
  workspace.createConversation(project.id);
  disappear();
  const dataDir = controller.dataDir;
  const alias = join(directory, 'data-alias');
  symlinkSync(dataDir, alias, 'junction');
  Object.assign(controller, { dataDir: alias });
  try {
    const moved = workspace.moveProjectToChats(project.id);
    assert.equal(moved.path, realpathSync.native(moved.path));
    assert.ok(moved.path.startsWith(join(realpathSync.native(dataDir), 'workspaces') + sep));
  } finally {
    Object.assign(controller, { dataDir });
    unlinkSync(alias);
  }
});

test('moving blocks all unstarted queue and confirmation tasks, including tasks outside paginated history', async (t) => {
  const { workspace, controller, project, disappear } = await setup(t);
  const chat = workspace.createConversation(project.id);
  for (const [id, status] of [
    ['approved', 'queued'],
    ['approval', 'waiting-approval'],
    ['queued', 'queued'],
    ['resource', 'waiting-resource'],
    ['approved-resource', 'waiting-resource'],
    ['review', 'waiting-confirmation'],
  ] as const)
    workspace.store.save('workflow', id, chat.id, {
      id,
      status,
      projectId: project.id,
      conversationId: chat.id,
      phase: 'queue',
      ...(id.startsWith('approved') ? { planReview: 'approved', startedAt: '2026-01-01' } : {}),
      input,
      runIds: [],
      createdAt: '',
      updatedAt: '',
    });
  const history = t.mock.method(workspace.store, 'workflows', () => []);
  const reserve = t.mock.method(controller, 'reserveProject', () => {
    assert.fail('Old tasks must never start');
  });
  disappear();
  workspace.moveProjectToChats(project.id);
  history.mock.restore();
  for (const id of ['approved', 'approval', 'queued', 'resource', 'approved-resource', 'review']) {
    const flow = workspace.store.get<Workflow>('workflow', id)!;
    assert.equal(flow.status, 'blocked');
    assert.equal(flow.error, notStarted);
  }
  await Object.getPrototypeOf(workspace).tickQueue.call(workspace);
  assert.equal(reserve.mock.callCount(), 0);
});

test('a project with only deleted chats is removed without making a workspace folder; archived chats count', async (t) => {
  const { workspace, controller, project, disappear } = await setup(t);
  const deleted = workspace.createConversation(project.id);
  workspace.store.deleteConversation(deleted.id);
  const root = join(controller.dataDir, 'workspaces');
  const before = existsSync(root) ? readdirSync(root) : [];
  disappear();
  assert.ok(workspace.moveProjectToChats(project.id).removedAt);
  assert.equal(workspace.state().removedProjects?.[0].id, project.id);
  assert.deepEqual(existsSync(root) ? readdirSync(root) : [], before);
  const other = await setup(t);
  const archived = other.workspace.createConversation(other.project.id);
  other.workspace.store.archiveConversation(archived.id, true);
  other.disappear();
  assert.equal(other.workspace.moveProjectToChats(other.project.id).scope, 'chat');
});

test('move refuses available, removed, unknown, active and pending-start projects', async (t) => {
  const { workspace, controller, project, disappear } = await setup(t);
  assert.throws(() => workspace.moveProjectToChats(project.id), { message: '文件夹还在，不需要移到对话。' });
  assert.throws(() => workspace.moveProjectToChats('unknown'), /项目不存在/);
  workspace.removeProject(project.id);
  assert.throws(() => workspace.moveProjectToChats(project.id), /项目不存在/);
  workspace.restoreProject(project.id);
  workspace.createConversation(project.id);
  disappear();
  workspace.refreshProjectFolders();
  mkdirSync(project.path);
  assert.throws(() => workspace.moveProjectToChats(project.id), { message: '文件夹还在，不需要移到对话。' });
  disappear();
  const active = t.mock.method(
    controller.active,
    'values',
    () => [{ run: { projectPath: project.path } }][Symbol.iterator]() as ReturnType<typeof controller.active.values>,
  );
  assert.throws(() => workspace.moveProjectToChats(project.id), /请先结束或取消这个项目中的任务/);
  active.mock.restore();
  const internal = workspace as unknown as { active: Map<string, unknown> };
  internal.active.set('starting', { pendingStart: true, workflow: { projectId: project.id } });
  try {
    assert.throws(() => workspace.moveProjectToChats(project.id), /请先结束或取消这个项目中的任务/);
    assert.equal(workspace.store.get<Project>('project', project.id)?.scope, undefined);
  } finally {
    internal.active.clear();
  }
});

test('only new dispatch projects get origin; user add clears it on existing and both restore paths', async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.method(workspace, 'tickQueue', async () => {});
  const send = workspace.send.bind(workspace);
  t.mock.method(workspace, 'send', (id: string, body: MessageInput) => send(id, { ...body, queue: true }));
  const tasks = new ExternalTasks(workspace);
  for (const name of ['dispatch', 'user']) mkdirSync(join(directory, name));
  const owned = await workspace.createProject(join(directory, 'user'));
  await tasks.dispatch({ task: 'Synthetic queued dispatch', projectPath: join(directory, 'dispatch'), readOnly: true });
  await tasks.dispatch({ task: 'Synthetic queued dispatch', projectPath: owned.path, readOnly: true });
  const dispatched = workspace.store.projects().find((p) => p.id !== owned.id)!;
  assert.equal(dispatched.origin, 'dispatch');
  assert.equal(workspace.store.get<Project>('project', owned.id)?.origin, undefined);
  assert.equal((await workspace.createProject(dispatched.path)).origin, 'dispatch');
  assert.equal(
    (await workspace.createProject(dispatched.path, undefined, false, { restoreRemoved: true })).origin,
    undefined,
  );
  for (const alias of [false, true]) {
    const folder = join(directory, alias ? 'canonical' : 'direct');
    mkdirSync(folder);
    const p = await workspace.createProject(folder, undefined, false, { origin: 'dispatch' });
    workspace.removeProject(p.id);
    const list = workspace.store.projects.bind(workspace.store);
    let firstLookup = true;
    const lookup = t.mock.method(workspace.store, 'projects', (removed = false) => {
      // Simulate a path alias that matches only after canonicalization.
      if (alias && firstLookup) {
        firstLookup = false;
        return [];
      }
      return list(removed);
    });
    const restored = await workspace.createProject(folder, undefined, false, { restoreRemoved: true });
    lookup.mock.restore();
    assert.equal(restored.id, p.id);
    assert.equal(restored.origin, undefined);
    assert.equal(workspace.store.get<Project>('project', p.id)?.origin, undefined);
  }
});

test('move refuses an active workflow between steps with no controller run', async (t) => {
  const { workspace, controller, project, disappear } = await setup(t);
  workspace.createConversation(project.id);
  disappear();
  const internal = workspace as unknown as { active: Map<string, unknown> };
  internal.active.set('between-steps', { pendingStart: false, workflow: { projectId: project.id } });
  try {
    assert.equal(controller.active.size, 0);
    assert.throws(() => workspace.moveProjectToChats(project.id), /请先结束或取消这个项目中的任务/);
    assert.equal(workspace.store.get<Project>('project', project.id)?.scope, undefined);
  } finally {
    internal.active.clear();
  }
});

test('dispatch reuses an automatically removed empty project after its folder is recreated', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  t.mock.method(workspace, 'tickQueue', async () => {});
  const send = workspace.send.bind(workspace);
  t.mock.method(workspace, 'send', (id: string, body: MessageInput) => send(id, { ...body, queue: true }));
  const tasks = new ExternalTasks(workspace);
  const folder = join(directory, 'recreated-worktree');
  mkdirSync(folder);
  const first = await tasks.dispatch({ task: 'Synthetic first dispatch', projectPath: folder, readOnly: true });
  const project = workspace.store.projects()[0];
  workspace.cancel(first.taskId);
  workspace.store.deleteConversation(first.conversationId);
  assert.ok(folder.startsWith(directory + sep));
  rmSync(folder, { recursive: true });
  workspace.refreshProjectFolders();
  assert.ok(workspace.store.get<Project>('project', project.id)?.removedAt);
  assert.equal(workspace.state().removedProjects?.[0].id, project.id);
  // Until the folder is back, a dispatch leaves the removed project and its chats alone.
  await assert.rejects(
    tasks.dispatch({ task: 'Synthetic early dispatch', projectPath: folder, readOnly: true }),
    /项目已从列表移除/,
  );
  assert.ok(workspace.store.get<Project>('project', project.id)?.removedAt);
  assert.equal(workspace.store.list<Conversation>('conversation', project.id, 100).length, 1);
  mkdirSync(folder);
  await assert.rejects(workspace.createProject(folder), /项目已从列表移除/);
  const broadcasts: Partial<AppState>[] = [];
  t.mock.method(controller, 'broadcast', () => broadcasts.push(workspace.state()));
  const second = await tasks.dispatch({ task: 'Synthetic next dispatch', projectPath: folder, readOnly: true });
  const restored = workspace.store.get<Project>('project', project.id)!;
  assert.equal(restored.origin, 'dispatch');
  assert.equal(restored.removedAt, undefined);
  assert.equal(workspace.store.get<Workflow>('workflow', second.taskId)?.projectId, project.id);
  assert.equal(workspace.store.projects(true).length, 1);
  assert.deepEqual(
    workspace.store.conversations(project.id).map((chat) => chat.id),
    [second.conversationId],
  );
  assert.ok(workspace.store.get<Conversation>('conversation', first.conversationId)?.deletedAt);
  assert.equal(workspace.state().projects?.[0].folderMissing, false);
  assert.ok(broadcasts.some((state) => state.projects?.[0].id === project.id && !state.projects[0].folderMissing));
  assert.deepEqual(workspace.state().removedProjects, []);
});

test('dispatch refuses removed user projects and dispatch projects with remaining or hidden chats', async (t) => {
  for (const kind of ['user', 'remaining', 'hidden'] as const) {
    const { workspace, project, folder } = await setup(t, kind === 'user' ? undefined : 'dispatch');
    const chat = kind === 'user' ? undefined : workspace.createConversation(project.id);
    if (kind === 'remaining') {
      workspace.store.save('project', project.id, project.id, { ...project, removedAt: '2026-01-01' });
    } else {
      workspace.removeProject(project.id);
    }
    const tasks = new ExternalTasks(workspace);
    await assert.rejects(
      tasks.dispatch({ task: 'Synthetic refused dispatch', projectPath: folder, readOnly: true }),
      /项目已从列表移除/,
    );
    assert.ok(workspace.store.get<Project>('project', project.id)?.removedAt);
    if (chat && kind === 'hidden') {
      assert.equal(workspace.store.conversations(project.id).length, 0);
      assert.equal(workspace.store.get<Conversation>('conversation', chat.id)?.removedWithProject, project.id);
    }
  }
});

test('existing projects are not saved or published on repeated dispatch or scheduled lookup', async (t) => {
  const { workspace, controller, project, directory } = await setup(t, 'dispatch');
  const userProject = await workspace.createProject(directory);
  const send = workspace.send.bind(workspace);
  t.mock.method(workspace, 'send', (id: string, body: MessageInput) => send(id, { ...body, queue: true }));
  const tasks = new ExternalTasks(workspace);
  const save = t.mock.method(workspace.store, 'save');
  const publish = t.mock.method(controller, 'broadcast');
  // Dispatch publishes chat/workflow state; project lookup itself must stay silent.
  const lookup = workspace.createProject.bind(workspace);
  t.mock.method(workspace, 'createProject', async (...args: Parameters<typeof lookup>) => {
    const before = publish.mock.callCount();
    const value = await lookup(...args);
    assert.equal(publish.mock.callCount(), before);
    return value;
  });
  for (const existing of [project, userProject]) {
    for (let index = 0; index < 2; index++) {
      await tasks.dispatch({ task: 'Synthetic queued dispatch', projectPath: existing.path, readOnly: true });
    }
    const count = publish.mock.callCount();
    assert.equal((await workspace.createProject(existing.path)).origin, existing.origin);
    assert.equal(publish.mock.callCount(), count);
    assert.equal(save.mock.calls.filter((call) => call.arguments[0] === 'project').length, 0);
  }
});

test('a returned folder invalidates and publishes cached state even when move is refused', async (t) => {
  const { workspace, controller, project, folder, disappear } = await setup(t);
  workspace.createConversation(project.id);
  disappear();
  workspace.refreshProjectFolders();
  assert.equal(workspace.state().projects?.[0].folderMissing, true);
  const broadcasts: Partial<AppState>[] = [];
  t.mock.method(controller, 'broadcast', () => {
    broadcasts.push(workspace.state());
  });
  mkdirSync(folder);
  assert.throws(() => workspace.moveProjectToChats(project.id), /文件夹还在/);
  assert.equal(workspace.state().projects?.[0].folderMissing, false);
  assert.equal(broadcasts.at(-1)?.projects?.[0].folderMissing, false);
  disappear();
  workspace.refreshProjectFolders();
  assert.equal(workspace.state().projects?.[0].folderMissing, true);
  mkdirSync(folder);
  const save = t.mock.method(workspace.store, 'save');
  const internal = workspace as unknown as { assertProjectFolder(project: Project): void };
  broadcasts.length = 0;
  internal.assertProjectFolder(project);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(workspace.state().projects?.[0].folderMissing, false);
  assert.equal(broadcasts.at(-1)?.projects?.[0].folderMissing, false);
});

test('moving twice returns the same chat project without more writes or folders', async (t) => {
  const { workspace, controller, project, disappear } = await setup(t);
  workspace.createConversation(project.id);
  disappear();
  const moved = workspace.moveProjectToChats(project.id);
  const folders = readdirSync(join(controller.dataDir, 'workspaces'));
  const save = t.mock.method(workspace.store, 'save');
  const publish = t.mock.method(controller, 'broadcast');
  assert.deepEqual(workspace.moveProjectToChats(project.id), moved);
  assert.equal(save.mock.callCount(), 0);
  assert.equal(publish.mock.callCount(), 0);
  assert.deepEqual(readdirSync(join(controller.dataDir, 'workspaces')), folders);
});

test('refresh preserves missing dispatch project paths and scope, removes empty ones and leaves user projects alone', async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.method(workspace, 'tickQueue', async () => {});
  const projects: Project[] = [];
  for (const name of ['auto', 'empty', 'user']) {
    const folder = join(directory, name);
    mkdirSync(folder);
    projects.push(
      await workspace.createProject(folder, undefined, false, { origin: name === 'user' ? undefined : 'dispatch' }),
    );
  }
  const chat = workspace.createConversation(projects[0].id);
  for (const p of projects) {
    assert.ok(p.path.startsWith(directory + sep));
    rmSync(p.path, { recursive: true });
  }
  assert.equal(workspace.store.get<Project>('project', projects[0].id)?.scope, undefined);
  workspace.refreshProjectFolders();
  assert.equal(workspace.store.get<Project>('project', projects[0].id)?.scope, undefined);
  assert.equal(workspace.store.get<Project>('project', projects[0].id)?.origin, 'dispatch');
  assert.equal(workspace.store.get<Project>('project', projects[0].id)?.path, projects[0].path);
  assert.equal(workspace.store.get<Conversation>('conversation', chat.id)?.projectId, projects[0].id);
  assert.equal(existsSync(projects[0].path), false);
  assert.ok(workspace.store.get<Project>('project', projects[1].id)?.removedAt);
  assert.equal(workspace.state().projects?.find((p) => p.id === projects[2].id)?.folderMissing, true);
  assert.equal(workspace.store.get<Project>('project', projects[2].id)?.scope, undefined);
});

test('refresh isolates empty-project removal failures and preserves dispatch projects with chats', async (t) => {
  const { workspace, directory } = fixture(t);
  const projects: Project[] = [];
  for (const name of ['broken', 'good', 'with-chat']) {
    const path = join(directory, name);
    workspace.store.save('project', name, name, {
      id: name,
      name,
      path,
      origin: 'dispatch',
      createdAt: '',
      updatedAt: '',
    });
    projects.push(workspace.store.get<Project>('project', name)!);
    if (name === 'with-chat') workspace.createConversation(name);
  }
  const remove = workspace.removeProject.bind(workspace);
  t.mock.method(workspace, 'removeProject', (id: string) => {
    if (id === 'broken') throw Error('Synthetic failure');
    return remove(id);
  });
  assert.doesNotThrow(() => workspace.refreshProjectFolders());
  for (const p of projects) assert.equal(workspace.store.get<Project>('project', p.id)?.scope, undefined);
  for (const p of projects) assert.equal(!!workspace.store.get<Project>('project', p.id)?.removedAt, p.id === 'good');
});
