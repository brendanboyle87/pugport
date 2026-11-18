import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { listedRemovedProjects } from '../src/shared/removed-projects.ts';
import type { Conversation, ExecuteContext, Project, RunRecord, Workflow } from '../src/shared/types.ts';
import { fixture, finished, input, result } from './helpers/session-workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { LocalMemoryScheduler } from '../src/server/local-memory-scheduler.ts';
import { ScheduledTasks } from '../src/server/scheduled-tasks.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';

test('a partial project purge cannot be restored or implicitly re-added', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  workspace.removeProject(project.id);
  workspace.store.save('project-purge', project.id, project.id, { startedAt: '2026-10-25' });
  assert.throws(() => workspace.restoreProject(project.id), /不能恢复部分数据/);
  await assert.rejects(workspace.createProject(directory, undefined, false, { restoreRemoved: true }), /清空尚未完成/);
  assert.ok(workspace.store.get<Project>('project', project.id)?.removedAt);
});

test('workspace purge drains local export state and returns an exact removed-project cleanup result', async (t) => {
  const { workspace, directory, controller } = fixture(t);
  const source = join(directory, 'original');
  mkdirSync(source);
  writeFileSync(join(source, 'keep.txt'), 'source');
  const project = await workspace.createProject(source);
  const conversation = workspace.createConversation(project.id);
  workspace.store.addMessage(conversation.id, 'user', 'saved');
  workspace.removeProject(project.id);
  const preview = await workspace.projectData.preview(project.id);
  assert.equal(preview.canPurge, true);
  const summaries = t.mock.method(controller.store, 'forgetRunSummaries', () => {});
  const result = await workspace.projectData.purge(project.id, preview.token);
  assert.equal(result.conversations, 1);
  assert.equal(workspace.store.get('project', project.id), undefined);
  assert.equal(workspace.store.get('local-memory-status', project.id), undefined);
  assert.equal(readFileSync(join(source, 'keep.txt'), 'utf8'), 'source');
  assert.equal(summaries.mock.callCount(), 1);
});

test('remove and restore hide project history without changing project files or restoring separately deleted chats', async (t) => {
  const { workspace, directory, controller } = fixture(t);
  const folder = join(directory, 'project');
  mkdirSync(folder);
  writeFileSync(join(folder, 'keep.txt'), 'synthetic contents');
  const project = await workspace.createProject(folder);
  t.mock.method(controller.store, 'runSummaries', () => [{ id: 'saved-run', projectPath: folder } as RunRecord]);
  assert.equal(controller.state().runs.length, 1);
  const conversation = workspace.createConversation(project.id, 'Visible');
  const deleted = workspace.createConversation(project.id, 'Already deleted');
  workspace.store.deleteConversation(deleted.id);
  workspace.store.addMessage(conversation.id, 'user', 'saved message');
  workspace.store.save('workflow', 'completed', conversation.id, {
    id: 'completed',
    projectId: project.id,
    conversationId: conversation.id,
    status: 'completed',
    updatedAt: '',
  });
  workspace.removeProject(project.id);
  const state = workspace.state();
  assert.deepEqual(controller.state().runs, []);
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.conversations, []);
  assert.deepEqual(state.conversationMessages, []);
  assert.deepEqual(state.workflows, []);
  assert.equal(state.removedProjects?.[0].id, project.id);
  assert.ok(workspace.store.get<Project>('project', project.id)?.removedAt);
  assert.throws(() => workspace.projectPath(project.id), /项目不存在/);
  assert.throws(() => workspace.conversation(conversation.id), /已删除/);
  assert.throws(() => workspace.createConversation(project.id), /项目不存在/);
  await assert.rejects(workspace.send(conversation.id, input), /已删除/);
  assert.deepEqual(readdirSync(folder), ['keep.txt']);
  assert.equal(readFileSync(join(folder, 'keep.txt'), 'utf8'), 'synthetic contents');
  workspace.restoreProject(project.id);
  assert.equal(controller.state().runs.length, 1);
  assert.equal(workspace.state().projects?.[0].id, project.id);
  assert.deepEqual(workspace.state().removedProjects, []);
  assert.deepEqual(
    workspace.store.conversations().map((value) => value.id),
    [conversation.id],
  );
  assert.equal(workspace.store.allMessages(conversation.id)[0].content, 'saved message');
  assert.ok(workspace.store.get<Conversation>('conversation', deleted.id)?.deletedAt);
  assert.equal(readFileSync(join(folder, 'keep.txt'), 'utf8'), 'synthetic contents');
});

test('every active or queued task status refuses project removal atomically', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  for (const status of [
    'queued',
    'waiting-resource',
    'planning',
    'running',
    'waiting-approval',
    'waiting-confirmation',
  ]) {
    workspace.store.save('workflow', 'busy', conversation.id, { id: 'busy', projectId: project.id, status });
    assert.throws(() => workspace.removeProject(project.id), /请先结束或取消这个项目中的任务/);
    assert.equal(workspace.store.projects().length, 1);
    assert.equal(workspace.store.conversations().length, 1);
    assert.equal(workspace.store.get<Project>('project', project.id)?.removedAt, undefined);
  }
  workspace.store.save('workflow', 'busy', conversation.id, { id: 'busy', projectId: project.id, status: 'cancelled' });
  workspace.removeProject(project.id);
  assert.equal(workspace.store.projects().length, 0);
});

test('adding the same canonical folder restores the project and conversations without duplicates', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  workspace.removeProject(project.id);
  workspace.removeProject(project.id);
  await assert.rejects(workspace.createProject(directory), /项目已从列表移除/);
  const restored = await workspace.createProject(join(directory, '.'), 'Do not duplicate', false, {
    restoreRemoved: true,
  });
  assert.equal(restored.id, project.id);
  assert.equal(restored.removedAt, undefined);
  assert.equal(workspace.store.projects(true).length, 1);
  assert.equal(workspace.store.conversations()[0].id, conversation.id);
  workspace.restoreProject(project.id);
  assert.equal(workspace.store.projects(true).length, 1);
});

test('a direct controller task also prevents project removal', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const active = t.mock.method(
    controller.active,
    'values',
    () => [{ run: { projectPath: directory } }][Symbol.iterator]() as ReturnType<typeof controller.active.values>,
  );
  assert.throws(() => workspace.removeProject(project.id), /请先结束或取消这个项目中的任务/);
  assert.equal(workspace.store.projects().length, 1);
  active.mock.restore();
});

test('missing folders are cached until refresh and restoring the list never recreates them', async (t) => {
  const { workspace, directory } = fixture(t);
  const path = join(directory, 'absent');
  const project: Project = { id: 'missing', name: 'Missing', path, createdAt: '', updatedAt: '' };
  workspace.store.save('project', project.id, project.id, project);
  const conversation = workspace.createConversation(project.id);
  workspace.refreshProjectFolders();
  assert.equal(workspace.state().projects?.[0].folderMissing, true);
  assert.equal(workspace.store.workflows().length, 0);
  assert.equal(workspace.store.allMessages(conversation.id).length, 0);
  workspace.removeProject(project.id);
  await assert.rejects(workspace.createProject(path, undefined, true), /项目已从列表移除/);
  assert.equal((await workspace.createProject(path, undefined, true, { restoreRemoved: true })).id, project.id);
  assert.equal(workspace.state().projects?.[0].folderMissing, true, 'restore never recreates the missing folder');
  mkdirSync(path);
  assert.equal(workspace.state().projects?.[0].folderMissing, true, 'broadcasts use the cache');
  workspace.refreshProjectFolders();
  assert.equal(workspace.state().projects?.[0].folderMissing, false);
});

test('missing-folder messages run read-only in scratch, keep identity, notify once and recover automatically', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const folder = join(directory, 'project');
  mkdirSync(folder);
  const project = await workspace.createProject(folder, 'Synthetic $& project');
  const conversation = workspace.createConversation(project.id);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply.', `session-${calls.length}`);
  });
  const send = async (missing = false) => {
    const sent = await workspace.send(conversation.id, {
      ...input,
      content: '你好',
      mode: missing ? 'build' : 'chat',
      planFirst: missing,
      runtimeId: 'mock',
      queue: true,
      explicitWrite: true,
    });
    const done = await finished(workspace, sent.workflow.id);
    assert.equal(done.status, 'completed', done.error ?? 'workflow must complete');
    return sent.workflow;
  };
  await send();
  assert.ok(folder.startsWith(directory + sep));
  rmSync(folder, { recursive: true });
  const scratch = join(controller.dataDir, 'workspaces', 'missing-folder', conversation.id);
  for (let i = 0; i < 2; i++) {
    const workflow = await send(true);
    assert.equal(workflow.input.folderMissing, true);
    assert.equal(workflow.input.mode, 'chat');
    assert.equal(workflow.input.permissionMode, 'read-only');
    assert.equal(workflow.input.explicitWrite, false);
    assert.equal(workflow.input.verificationCommand, undefined);
    assert.equal(calls.at(-1)!.input.projectPath, scratch);
    assert.equal(calls.at(-1)!.input.permissionMode, 'read-only');
    assert.ok(calls.at(-1)!.input.prompt.includes(folder));
    assert.match(calls.at(-1)!.input.prompt, /本轮仅聊天，不能读取或修改项目文件/);
    assert.equal(existsSync(folder), false);
    assert.equal(workspace.store.get<Project>('project', project.id)!.path, folder);
    assert.equal(workspace.store.get<Conversation>('conversation', conversation.id)!.projectId, project.id);
  }
  assert.equal(calls[1].nativeSessionId, undefined, 'never resume the original workspace session in scratch');
  const notices = () =>
    workspace.store.allMessages(conversation.id).filter((m) => m.systemNotice?.text.includes('文件夹回来后自动恢复'));
  assert.equal(notices().length, 1);
  assert.equal(
    notices()[0].content,
    `「${project.name}」的文件夹现在找不到了，先按聊天回复，不会读写文件；文件夹回来后自动恢复。`,
  );
  assert.equal(notices()[0].replyIdentity?.kind, 'system');
  project.name = 'Renamed synthetic project';
  workspace.store.save('project', project.id, project.id, project);
  await send(true);
  assert.equal(notices().length, 1, 'renaming the project must not repeat the notice');
  mkdirSync(folder);
  const restored = await send();
  assert.equal(restored.input.folderMissing, undefined);
  assert.equal(restored.input.permissionMode, 'workspace-write');
  assert.equal(calls.at(-1)!.input.projectPath, folder);
  assert.equal(calls.at(-1)!.input.permissionMode, 'workspace-write');
  assert.doesNotMatch(calls.at(-1)!.input.prompt, /文件夹现在找不到了|文件夹回来后自动恢复|本轮仅聊天/);
  assert.ok(
    workspace.store
      .contextMessages(conversation.id, restored.userMessageId)
      .every((m) => m.replyIdentity?.kind !== 'system'),
  );
  assert.notEqual(calls.at(-1)!.nativeSessionId, 'session-3');
  assert.equal(calls.at(-1)!.nativeSessionId, 'session-1', 'resume the original workspace session after recovery');
  assert.equal(notices().length, 1);
});

test('missing-folder interrupted tasks accept plain continue without queue and the Continue action', async (t) => {
  for (const action of ['message', 'button'] as const) {
    await t.test(action, async (t) => {
      const { workspace, controller, directory } = fixture(t);
      const folder = join(directory, 'project');
      mkdirSync(folder);
      const project = await workspace.createProject(folder);
      const conversation = workspace.createConversation(project.id);
      conversation.queueingEnabled = false;
      workspace.store.save('conversation', conversation.id, project.id, conversation);
      const tick = t.mock.method(workspace, 'tickQueue', async () => {});
      if (action === 'button') rmSync(folder, { recursive: true });
      const first = await workspace.send(conversation.id, { ...input, content: '你好', runtimeId: 'mock' });
      workspace.store.save('workflow', first.workflow.id, conversation.id, {
        ...first.workflow,
        status: 'interrupted',
      });
      if (action === 'message') rmSync(folder, { recursive: true });
      const calls: ExecuteContext[] = [];
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        return result('completed', 'Synthetic continued reply.');
      });
      const next =
        action === 'message'
          ? await workspace.send(conversation.id, { ...input, content: '继续', runtimeId: 'mock' })
          : await workspace.continue(first.workflow.id);
      assert.equal(next.workflow.parentWorkflowId, first.workflow.id);
      assert.equal(next.workflow.input.queue, undefined, 'do not force the queue or override steering preferences');
      assert.equal(next.workflow.input.folderMissing, true);
      assert.equal(next.workflow.input.mode, 'chat');
      assert.equal(next.workflow.input.permissionMode, 'read-only');
      if (action === 'message') assert.equal(next.message.content, '继续');
      tick.mock.restore();
      await workspace.tickQueue();
      const done = await finished(workspace, next.workflow.id);
      assert.equal(done.status, 'completed', done.error ?? 'workflow must complete');
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].input.projectPath,
        join(controller.dataDir, 'workspaces', 'missing-folder', conversation.id),
      );
      assert.equal(calls[0].input.permissionMode, 'read-only');
      assert.equal(workspace.store.get<Project>('project', project.id)!.path, folder);
      assert.equal(workspace.store.get<Conversation>('conversation', conversation.id)!.projectId, project.id);
      assert.equal(existsSync(folder), false);
    });
  }
});

test('missing-folder live chat preserves steering and queue preferences and isolates restored folders', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const folder = join(directory, 'absent');
  mkdirSync(folder);
  const project = await workspace.createProject(folder);
  assert.ok(folder.startsWith(directory + sep));
  rmSync(folder, { recursive: true });
  const conversation = workspace.createConversation(project.id);
  conversation.queueingEnabled = false;
  workspace.store.save('conversation', conversation.id, conversation.projectId, conversation);
  controller.snapshots[0].capabilities.steer = true;
  let context!: ExecuteContext;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      context = ctx;
      await new Promise<void>((done) => {
        release = done;
        ctx.signal.addEventListener('abort', () => done(), { once: true });
        resolve();
      });
      return result('completed', 'Synthetic reply.');
    });
  });
  const chatInput = {
    ...input,
    content: '你好',
    mode: 'chat' as const,
    permissionMode: 'read-only' as const,
    runtimeId: 'mock',
  };
  const first = await workspace.send(conversation.id, chatInput);
  await ready;
  const received: string[] = [];
  context.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  const update = await workspace.send(conversation.id, { ...chatInput, content: '再举一个例子' });
  assert.equal(update.workflow.id, first.workflow.id);
  assert.equal(update.message.steering?.status, 'accepted');
  assert.equal(received.length, 1);
  assert.equal(existsSync(folder), false);
  context.registerSteer?.(undefined, { state: 'waiting', reason: 'Synthetic pause' });
  await assert.rejects(workspace.send(conversation.id, { ...chatInput, content: '补充说明' }), /已关闭排队/);
  context.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  mkdirSync(folder);
  const tick = t.mock.method(workspace, 'tickQueue', async () => {});
  const restored = await workspace.send(conversation.id, { ...chatInput, content: '目录恢复了' });
  assert.notEqual(restored.workflow.id, first.workflow.id);
  assert.equal(restored.workflow.input.folderMissing, undefined);
  assert.equal(received.length, 1, 'do not steer a restored project turn into the scratch session');
  release();
  await finished(workspace, first.workflow.id);
  tick.mock.restore();
});

test('missing-folder daily routines fail without executor calls on consecutive days', async (t) => {
  const { workspace, directory } = fixture(t);
  const folder = join(directory, 'project');
  mkdirSync(folder);
  const project = await workspace.createProject(folder);
  let now = new Date(2026, 0, 5, 8);
  const tasks = new ScheduledTasks(workspace, () => now);
  t.after(() => tasks.close());
  const routine = tasks.create({
    name: 'Daily synthetic review',
    prompt: 'Summarize the project.',
    schedule: { type: 'daily', time: '09:00' },
    permissionMode: 'read-only',
    executor: 'mock',
  });
  // A routine can retain only its project ID after its first general-chat run.
  workspace.store.save('routine', routine.id, routine.id, { ...routine, projectId: project.id });
  tasks.setEnabled(routine.id, true);
  rmSync(folder, { recursive: true });
  const execute = t.mock.method(codexAdapter, 'execute', async () => result('completed', 'Unexpected execution.'));
  for (const day of [5, 6]) {
    now = new Date(2026, 0, day, 10);
    await tasks.tick();
    const latest = tasks.get(routine.id).history.at(-1)!;
    assert.equal(latest.status, 'failed');
    assert.match(latest.reason!, /文件夹已不存在/);
    assert.equal(workspace.store.workflows().length, 0);
  }
  assert.equal(tasks.get(routine.id).history.length, 2);
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(existsSync(folder), false);
});

test('missing-folder external dispatch continuation refuses instead of converting a write to chat', async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.method(workspace, 'tickQueue', async () => {});
  const folder = join(directory, 'project');
  mkdirSync(folder);
  const tasks = new ExternalTasks(workspace);
  const first = await tasks.dispatch({
    task: 'Synthetic task',
    projectPath: folder,
    caller: 'synthetic-mcp',
    callerContext: {
      client: 'terminal',
      mode: 'write',
      roots: [folder],
      cwd: folder,
      evidence: ['identity: pugport command'],
      verified: false,
    },
    write: true,
  });
  const old = workspace.store.get<Workflow>('workflow', first.taskId)!;
  workspace.store.save('workflow', old.id, old.conversationId, { ...old, status: 'interrupted' });
  const messages = workspace.store.allMessages(first.conversationId);
  rmSync(folder, { recursive: true });
  const execute = t.mock.method(codexAdapter, 'execute', async () => result('completed', 'Unexpected execution.'));
  await assert.rejects(
    tasks.dispatch({ task: '继续', conversationId: first.conversationId, caller: 'synthetic-mcp' }),
    /文件夹已不存在/,
  );
  await assert.rejects(
    workspace.send(first.conversationId, { ...input, permissionOrigin: { source: 'caller', mode: 'workspace-write' } }),
    /文件夹已不存在/,
  );
  assert.equal(workspace.store.workflows().length, 1);
  assert.deepEqual(workspace.store.allMessages(first.conversationId), messages);
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(existsSync(folder), false);
});

test('missing-folder delegated and approved-plan continuations still refuse before creating messages', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = { id: 'missing', name: 'Missing', path: join(directory, 'absent'), createdAt: '', updatedAt: '' };
  workspace.store.save('project', project.id, project.id, project);
  const conversation = workspace.createConversation(project.id);
  workspace.store.save('workflow', 'approved', conversation.id, {
    id: 'approved',
    projectId: project.id,
    conversationId: conversation.id,
    planReview: 'approved',
  });
  await assert.rejects(workspace.send(conversation.id, input, 'approved'), /文件夹已不存在/);
  await assert.rejects(
    workspace.send(conversation.id, input, undefined, {
      parentId: 'approved',
      requestId: 'part',
      role: 'worker',
    }),
    /文件夹已不存在/,
  );
  assert.equal(workspace.store.allMessages(conversation.id).length, 0);
});

test('a marked queued chat keeps its scratch directory even if the folder returns before wake', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const folder = join(directory, 'project');
  mkdirSync(folder);
  const project = await workspace.createProject(folder);
  const conversation = workspace.createConversation(project.id);
  const tick = t.mock.method(workspace, 'tickQueue', async () => {});
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply.');
  });
  assert.ok(folder.startsWith(directory + sep));
  rmSync(folder, { recursive: true });
  const sent = await workspace.send(conversation.id, { ...input, runtimeId: 'mock' });
  assert.equal(sent.workflow.input.folderMissing, true);
  assert.equal(sent.workflow.status, 'queued');
  mkdirSync(folder);
  tick.mock.restore();
  await workspace.tickQueue();
  assert.equal((await finished(workspace, sent.workflow.id)).status, 'completed');
  assert.equal(calls[0].input.projectPath, join(controller.dataDir, 'workspaces', 'missing-folder', conversation.id));
  assert.equal(calls[0].input.permissionMode, 'read-only');
  assert.equal(workspace.store.get<Project>('project', project.id)!.path, folder);
});

test('a queued task whose folder vanished is blocked before executor admission', async (t) => {
  for (const origin of [undefined, 'dispatch'] as const) {
    await t.test(origin ?? 'user', async (t) => {
      const { workspace, directory, controller } = fixture(t);
      const folder = join(directory, 'project');
      mkdirSync(folder);
      const project = await workspace.createProject(folder, undefined, false, { origin });
      const conversation = workspace.createConversation(project.id);
      workspace.store.save('workflow', 'queued', conversation.id, {
        id: 'queued',
        projectId: project.id,
        conversationId: conversation.id,
        status: 'queued',
        phase: 'queue',
        input,
        runIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const reserve = t.mock.method(controller, 'reserveProject', () => {
        assert.fail('A task whose folder vanished must not start');
      });
      assert.ok(folder.startsWith(directory + sep));
      rmSync(folder, { recursive: true });
      await workspace.tickQueue();
      assert.equal(workspace.store.get<Workflow>('workflow', 'queued')?.status, 'blocked');
      assert.equal(
        workspace.store.get<Workflow>('workflow', 'queued')?.error,
        origin === 'dispatch'
          ? '文件夹已不存在，这个任务没有启动。请重新发送。'
          : '文件夹已不存在，无法启动任务。请恢复文件夹，或点「移到对话」继续。',
      );
      assert.equal(controller.active.size, 0);
      assert.equal(reserve.mock.callCount(), 0);
    });
  }
});

test('project endpoints use the global mutating session-token middleware and state refreshes folder flags', () => {
  const source = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  const middleware = source.indexOf('app.use(localApiGuard(token, allowedHosts, allowedOrigins))');
  for (const route of [
    "app.delete('/api/projects/:id'",
    "app.post('/api/projects/:id/restore'",
    "app.post('/api/projects/:id/move-to-chats'",
  ])
    assert.ok(source.indexOf(route) > middleware && middleware > 0);
  assert.match(source, /app\.get\('\/api\/state'[\s\S]*?workspace\.refreshProjectFolders\(\)/);
});

test('removed projects are excluded from memory refresh, flush and Grok history imports', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  workspace.removeProject(project.id);
  const schedule = t.mock.method(LocalMemoryScheduler.prototype, 'schedule', () => {});
  const flush = t.mock.method(LocalMemoryScheduler.prototype, 'flush', async (projectId: string) => ({
    projectId,
    warnings: [],
    files: [],
  }));
  const internal = workspace as unknown as { refreshMemories(projectId?: string): void };
  internal.refreshMemories();
  internal.refreshMemories(project.id);
  assert.deepEqual(await workspace.flushLocalMemory(), []);
  assert.equal(schedule.mock.callCount(), 0);
  assert.equal(flush.mock.callCount(), 0);
  await assert.rejects(workspace.syncGrokHistory(project.id), /项目不存在/);
});

test('folder refresh skips removed projects and treats chat projects as available', async (t) => {
  const { workspace, directory } = fixture(t);
  for (const [id, extra] of [
    ['visible', {}],
    ['removed', { removedAt: '2026-01-01' }],
    ['chat', { scope: 'chat' }],
  ] as const)
    workspace.store.save('project', id, id, { id, path: join(directory, id), ...extra });
  const internal = workspace as unknown as { folderMissing(project: Project, refresh?: boolean): boolean };
  const check = t.mock.method(internal, 'folderMissing');
  workspace.refreshProjectFolders();
  assert.deepEqual(check.mock.calls.map((call) => call.arguments[0].id).sort(), ['chat', 'visible']);
  assert.equal(check.mock.calls.find((call) => call.arguments[0].id === 'chat')!.result, false);
  assert.equal(check.mock.calls.find((call) => call.arguments[0].id === 'visible')!.result, true);
});

test('Clear list keeps removed state for hiding tasks and preserves unfinished purge entries', async (t) => {
  const { workspace, directory, controller } = fixture(t);
  const folder = join(directory, 'clear-list-source');
  mkdirSync(folder);
  const project = await workspace.createProject(folder);
  const conversation = workspace.createConversation(project.id);
  t.mock.method(controller.store, 'runSummaries', () => [{ id: 'old-run', projectPath: folder } as RunRecord]);
  workspace.store.save('workflow', 'old-task', conversation.id, {
    id: 'old-task',
    projectId: project.id,
    conversationId: conversation.id,
    status: 'completed',
    updatedAt: '',
    runIds: [],
  });
  workspace.removeProject(project.id);
  workspace.clearRemovedProjects();
  assert.equal(workspace.state().removedProjects?.length, 1);
  assert.equal(workspace.state().workflows?.length, 0);
  assert.equal(controller.state().runs.length, 0);
  assert.deepEqual(
    listedRemovedProjects(workspace.state().removedProjects, controller.settings.removedProjectsClearedAt),
    [],
  );
  workspace.store.save('project-purge', project.id, project.id, { startedAt: '2026-10-27' });
  const state = workspace.state();
  assert.equal(state.removedProjects?.[0].purgePending, true);
  assert.deepEqual(
    listedRemovedProjects(state.removedProjects, controller.settings.removedProjectsClearedAt).map((item) => item.id),
    [project.id],
  );
  assert.equal(state.workflows?.length, 0);
  assert.equal(controller.state().runs.length, 0);
});
