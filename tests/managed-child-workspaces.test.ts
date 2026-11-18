import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace, workspaceDeliveryComplete } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { ManagedWorktrees } from '../src/server/managed-worktrees.ts';
import { ConversationAutomation } from '../src/server/conversation-automation.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import type { Conversation } from '../src/shared/types.ts';
import type { ExecuteContext, ExecuteResult, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

function fixture(t: TestContext, git = true) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'managed-workspace-runtime-')));
  const projectDirectory = join(directory, 'project');
  mkdirSync(projectDirectory);
  writeFileSync(join(projectDirectory, 'a.txt'), 'base a\n');
  writeFileSync(join(projectDirectory, 'b.txt'), 'base b\n');
  const runGit = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], {
      cwd: projectDirectory,
      windowsHide: true,
      encoding: 'utf8',
    });
  if (git) {
    runGit('init', '--quiet');
    runGit('add', '.');
    runGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base');
  }
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = [
    { id: 'codex-a', provider: 'codex', label: 'Codex A' },
    { id: 'codex-b', provider: 'codex', label: 'Codex B' },
    { id: 'claude-a', provider: 'claude', label: 'Claude A' },
  ].map((target) => ({ ...target, command: 'unused', environment: 'native', enabled: true }) as RuntimeTarget);
  controller.snapshots = controller.targets.map((target): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 7200000).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 64 * 1024 ** 3,
    availableMemoryBytes: 32 * 1024 ** 3,
    cpus: 32,
  }));
  const calls: ExecuteContext[] = [];
  const failures: string[] = [];
  let behavior: (ctx: ExecuteContext) => Promise<string> = async () => 'Verified.';
  const execute = async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    ctx.registerSteer?.(async () => {});
    try {
      return { output: await behavior(ctx), nativeSessionId: `fixture-${calls.length}` };
    } catch (error) {
      failures.push(String(error));
      throw error;
    }
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await bridge.close();
    await workspace.close();
    await controller.close();
    const target = resolve(directory);
    assert.ok(
      target.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(target).startsWith('managed-workspace-runtime-'),
    );
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const ask = async (ctx: ExecuteContext, name: string, args: Record<string, unknown>) => {
    const reply = await bridge.handle(`Bearer ${ctx.agentBridge!.token}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return (reply.body as { result: { content: { text: string }[] } }).result.content
      .map((block) => block.text)
      .join('\n');
  };
  const start = async () => {
    const project = await workspace.createProject(projectDirectory);
    const conversation = workspace.createConversation(project.id);
    const sent = await workspace.send(conversation.id, {
      content: 'Edit the project files with independent workers',
      mode: 'chat',
      permissionMode: 'workspace-write',
      explicitWrite: true,
      executionPolicy: 'cli-first',
      autoEscalate: false,
      runtimeId: 'codex-a',
    });
    return { ...sent, project, conversation };
  };
  return {
    workspace,
    controller,
    calls,
    failures,
    ask,
    start,
    directory,
    projectDirectory,
    runGit,
    set: (fn: typeof behavior) => {
      behavior = fn;
    },
  };
}
const ids = (reply: string) => [...reply.matchAll(/task_id: ([0-9a-f-]{36})/g)].map((match) => match[1]!);
async function laneFixture(t: TestContext, git = true) {
  const f = fixture(t, git);
  const project = await f.workspace.createProject(f.projectDirectory);
  const conversation = f.workspace.createConversation(project.id);
  const source = {
    id: randomUUID(),
    conversationId: conversation.id,
    projectId: project.id,
    status: 'completed',
    input: { permissionMode: 'read-only' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runIds: [],
  } as unknown as Workflow;
  f.workspace.store.save('workflow', source.id, conversation.id, source);
  const automation = new ConversationAutomation(f.workspace);
  t.after(() => automation.close());
  const actor = { conversationId: conversation.id, workflowId: source.id, source: 'agent' as const, write: false };
  const managed = new ManagedWorktrees(join(f.controller.dataDir, 'workspaces', 'managed-children'));
  return { ...f, project, conversation, source, automation, actor, managed };
}

test('lanes persist a local base ref and branch, recover the original commit, and never set an upstream', async (t) => {
  const f = await laneFixture(t);
  const base = f.runGit('rev-parse', 'HEAD').trim();
  f.runGit('update-ref', 'refs/remotes/origin/develop', base);
  writeFileSync(join(f.projectDirectory, 'a.txt'), 'new source commit\n');
  f.runGit('add', '.');
  f.runGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'next');
  const head = f.runGit('rev-parse', 'HEAD').trim();
  const request = { requestId: randomUUID(), title: 'Selected lane', base: 'origin/develop', branch: 'alice/x' };
  const lane = await f.automation.createLane(f.actor, request);
  const saved = f.workspace.store.get<Conversation>('conversation', lane.id)!;
  assert.equal(saved.lane?.base, request.base);
  assert.equal(saved.lane?.branch, request.branch);
  assert.equal(saved.lane?.workspaceId, lane.id);
  const directory = await f.workspace.conversationExecutionPath(lane.id);
  assert.equal(f.runGit('-C', directory, 'branch', '--show-current').trim(), request.branch);
  assert.equal(f.runGit('-C', directory, 'rev-parse', 'HEAD').trim(), base);
  assert.equal(f.runGit('for-each-ref', '--format=%(upstream)', `refs/heads/${request.branch}`).trim(), '');
  assert.throws(() => f.runGit('config', '--get-regexp', '^branch\\.alice/x\\.(remote|merge)$'));
  f.runGit('update-ref', 'refs/remotes/origin/develop', head);
  const resumed = new ConversationAutomation(f.workspace);
  t.after(() => resumed.close());
  assert.equal((await resumed.createLane(f.actor, request)).id, lane.id);
  assert.equal(f.runGit('-C', directory, 'rev-parse', 'HEAD').trim(), base);
  const defaultLane = await f.automation.createLane(f.actor, { requestId: randomUUID(), title: 'Default lane' });
  const defaultDirectory = await f.workspace.conversationExecutionPath(defaultLane.id);
  assert.equal(f.runGit('-C', defaultDirectory, 'branch', '--show-current').trim(), `codex/managed-${defaultLane.id}`);
  assert.equal(f.runGit('-C', defaultDirectory, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(f.calls.length, 0);
});

test('lane base errors leave no conversation or request, and corrected new requests succeed', async (t) => {
  const f = await laneFixture(t);
  for (const base of ['origin/develop', '--help']) {
    const request = { requestId: randomUUID(), title: 'Retry lane', base, branch: `alice/${randomUUID()}` };
    const conversations = f.workspace.store.conversations(f.project.id);
    const before = f.runGit('worktree', 'list', '--porcelain');
    await assert.rejects(f.automation.createLane(f.actor, request), /origin\/develop|--help/);
    assert.deepEqual(f.workspace.store.conversations(f.project.id), conversations);
    assert.equal(f.workspace.store.get('lane-request', request.requestId), undefined);
    assert.equal(f.runGit('worktree', 'list', '--porcelain'), before);
    assert.equal(f.runGit('for-each-ref', '--format=%(refname)', `refs/heads/${request.branch}`).trim(), '');
    const retried = await f.automation.createLane(f.actor, { ...request, requestId: randomUUID(), base: 'HEAD' });
    const directory = await f.workspace.conversationExecutionPath(retried.id);
    assert.equal(f.runGit('-C', directory, 'branch', '--show-current').trim(), request.branch);
    assert.equal(f.runGit('-C', directory, 'rev-parse', 'HEAD').trim(), f.runGit('rev-parse', 'HEAD').trim());
  }
});

test('lanes reject invalid, existing and checked-out branch names without changing those worktrees', async (t) => {
  const f = await laneFixture(t);
  f.runGit('branch', 'alice/existing');
  const other = join(f.directory, 'other');
  f.runGit('worktree', 'add', '-b', 'alice/checked-out', other, 'HEAD');
  writeFileSync(join(other, 'a.txt'), 'retained work\n');
  const missingRef = join(f.directory, 'missing-ref');
  f.runGit('worktree', 'add', '-b', 'alice/checked-out-missing-ref', missingRef, 'HEAD');
  f.runGit('update-ref', '-d', 'refs/heads/alice/checked-out-missing-ref');
  writeFileSync(join(missingRef, 'a.txt'), 'retained work without ref\n');
  for (const branch of ['alice/../invalid', 'alice/existing', 'alice/checked-out', 'alice/checked-out-missing-ref']) {
    const request = { requestId: randomUUID(), title: branch, branch };
    const conversations = f.workspace.store.conversations(f.project.id);
    const before = f.runGit('worktree', 'list', '--porcelain');
    const refs = f.runGit('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
    await assert.rejects(f.automation.createLane(f.actor, request));
    assert.deepEqual(f.workspace.store.conversations(f.project.id), conversations);
    assert.equal(f.workspace.store.get('lane-request', request.requestId), undefined);
    assert.equal(f.runGit('worktree', 'list', '--porcelain'), before);
    assert.equal(f.runGit('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), refs);
    const corrected = { ...request, requestId: randomUUID(), branch: `alice/${randomUUID()}` };
    const retried = await f.automation.createLane(f.actor, corrected);
    const directory = await f.workspace.conversationExecutionPath(retried.id);
    assert.equal(f.runGit('-C', directory, 'branch', '--show-current').trim(), corrected.branch);
  }
  assert.equal(readFileSync(join(other, 'a.txt'), 'utf8'), 'retained work\n');
  assert.equal(readFileSync(join(missingRef, 'a.txt'), 'utf8'), 'retained work without ref\n');
});

test('racing lane requests roll back only the losing lane and its failed workspace record', async (t) => {
  const f = await laneFixture(t);
  const request = { title: 'Racing lane', base: 'HEAD', branch: 'synthetic/racing-lane' };
  const requests = [0, 1].map(() => ({ ...request, requestId: randomUUID() }));
  const validate = f.workspace.validateLaneWorkspace.bind(f.workspace);
  let release!: () => void;
  const validated = new Promise<void>((done) => {
    release = done;
  });
  let arrivals = 0;
  t.mock.method(f.workspace, 'validateLaneWorkspace', async (...args: Parameters<typeof validate>) => {
    const commit = await validate(...args);
    if (++arrivals === 2) release();
    await validated;
    return commit;
  });
  const prepare = f.workspace.prepareLaneWorkspace.bind(f.workspace);
  const attempted: string[] = [];
  let first!: Promise<Conversation>;
  t.mock.method(f.workspace, 'prepareLaneWorkspace', async (id: string) => {
    attempted.push(id);
    if (attempted.length === 1) {
      first = prepare(id);
      return first;
    }
    await first;
    return prepare(id);
  });
  const results = await Promise.allSettled(requests.map((value) => f.automation.createLane(f.actor, value)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.findIndex((result) => result.status === 'rejected');
  assert.match(String((results[failed] as PromiseRejectedResult).reason), /Branch already exists/);
  const lanes = f.workspace.store.conversations(f.project.id).filter((value) => value.lane);
  assert.equal(lanes.length, 1);
  const loser = attempted.find((id) => id !== lanes[0].id)!;
  assert.ok(f.workspace.store.get<Conversation>('conversation', loser)?.deletedAt);
  assert.equal(f.workspace.store.get('lane-request', requests[failed].requestId), undefined);
  assert.equal(await f.managed.inspect(loser), undefined);
  const winner = await f.managed.inspect(lanes[0].id);
  assert.equal(winner?.state, 'ready');
  assert.equal(f.runGit('rev-parse', request.branch).trim(), winner?.baseCommit);
  assert.equal(readFileSync(join(winner!.directory, 'a.txt'), 'utf8'), 'base a\n');
});

test('a branch created by the owner after lane preflight is retained while the new lane is rolled back', async (t) => {
  const f = await laneFixture(t);
  const request = { requestId: randomUUID(), title: 'Owner race', base: 'HEAD', branch: 'synthetic/owner-race' };
  const validate = f.workspace.validateLaneWorkspace.bind(f.workspace);
  const before = f.runGit('worktree', 'list', '--porcelain');
  t.mock.method(f.workspace, 'validateLaneWorkspace', async (...args: Parameters<typeof validate>) => {
    const commit = await validate(...args);
    f.runGit('branch', request.branch);
    return commit;
  });
  await assert.rejects(f.automation.createLane(f.actor, request), /Branch already exists/);
  assert.equal(f.workspace.store.conversations(f.project.id).filter((value) => value.lane).length, 0);
  const lane = f.workspace.store.list<Conversation>('conversation', f.project.id).find((value) => value.lane)!;
  assert.ok(lane.deletedAt);
  assert.equal(f.workspace.store.get('lane-request', request.requestId), undefined);
  assert.equal(await f.managed.inspect(lane.id), undefined);
  assert.equal(f.runGit('rev-parse', request.branch).trim(), f.runGit('rev-parse', 'HEAD').trim());
  assert.equal(f.runGit('worktree', 'list', '--porcelain'), before);
});

test('an interrupted lane keeps its preflight commit even when the base ref moves before preparation', async (t) => {
  const f = await laneFixture(t);
  const base = f.runGit('rev-parse', 'HEAD').trim();
  f.runGit('update-ref', 'refs/remotes/origin/develop', base);
  writeFileSync(join(f.projectDirectory, 'a.txt'), 'later commit\n');
  f.runGit('add', '.');
  f.runGit('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'later');
  const request = { requestId: randomUUID(), title: 'Pinned base', base: 'origin/develop', branch: 'synthetic/pinned' };
  const prepare = f.workspace.prepareLaneWorkspace.bind(f.workspace);
  const interruption = t.mock.method(f.workspace, 'prepareLaneWorkspace', async () => {
    f.runGit('update-ref', 'refs/remotes/origin/develop', 'HEAD');
    throw new Error('Synthetic preparation interruption');
  });
  await assert.rejects(f.automation.createLane(f.actor, request), /Synthetic preparation interruption/);
  const saved = f.workspace.store.conversations(f.project.id).find((value) => value.lane)!;
  assert.equal(saved.lane?.baseCommit, base);
  interruption.mock.restore();
  const inspect = t.mock.method(ManagedWorktrees.prototype, 'inspect', async () => {
    throw new Error('A stored lane commit must not require inspect');
  });
  const lane = await f.automation.createLane(f.actor, request);
  assert.equal(lane.id, saved.id);
  const directory = await f.workspace.conversationExecutionPath(lane.id);
  assert.equal(f.runGit('-C', directory, 'rev-parse', 'HEAD').trim(), base);
  assert.equal(inspect.mock.callCount(), 0);
  assert.equal((await prepare(lane.id)).lane?.baseCommit, base);
});

test('plain-folder lanes keep the default path but reject explicit Git base or branch choices', async (t) => {
  const f = await laneFixture(t, false);
  for (const selection of [{ base: 'origin/develop' }, { branch: 'alice/x' }]) {
    const request = { requestId: randomUUID(), title: 'Git selection', ...selection };
    const conversations = f.workspace.store.conversations(f.project.id);
    await assert.rejects(f.automation.createLane(f.actor, request), /Git/);
    assert.deepEqual(f.workspace.store.conversations(f.project.id), conversations);
    assert.equal(f.workspace.store.get('lane-request', request.requestId), undefined);
    const lane = await f.automation.createLane(f.actor, { requestId: randomUUID(), title: 'Plain lane' });
    assert.equal(lane.lane?.workspaceId, undefined);
    assert.equal(await f.workspace.conversationExecutionPath(lane.id), f.projectDirectory);
  }
});

async function finish(workspace: Workspace, id: string) {
  for (let i = 0; i < 6000; i++) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) {
      await workspace.scopeChecked(id);
      return workflow;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('fixture did not settle');
}

test('Git children see dirty source bytes, keep project identity, and deliver only after the parent parks', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.projectDirectory, 'a.txt'), 'dirty parent a\n');
  f.runGit('add', 'a.txt');
  writeFileSync(join(f.projectDirectory, 'untracked.txt'), 'dirty untracked\n');
  const index = readFileSync(join(f.projectDirectory, '.git', 'index'));
  let childId = '';
  let childDirectory = '';
  f.set(async (ctx) => {
    if (ctx.input.agentChild) {
      childId = ctx.input.workflowId!;
      childDirectory = ctx.input.projectPath;
      assert.notEqual(childDirectory, f.projectDirectory);
      assert.equal(readFileSync(join(childDirectory, 'a.txt'), 'utf8'), 'dirty parent a\n');
      assert.equal(readFileSync(join(childDirectory, 'untracked.txt'), 'utf8'), 'dirty untracked\n');
      assert.equal(f.workspace.store.get<Workflow>('workflow', childId)?.projectId, root.project.id);
      assert.equal(ctx.input.permissionMode, 'workspace-write');
      assert.equal(f.controller.managedExecutionWorkspace?.(ctx.input)?.directory, childDirectory);
      assert.equal(
        f.controller.managedExecutionWorkspace?.({ ...ctx.input, projectPath: f.projectDirectory }),
        undefined,
      );
      assert.equal(
        f.controller.managedExecutionWorkspace?.({ ...ctx.input, workflowId: 'unowned-workflow' }),
        undefined,
      );
      writeFileSync(join(childDirectory, 'b.txt'), 'child b\n');
      assert.equal(readFileSync(join(f.projectDirectory, 'b.txt'), 'utf8'), 'base b\n');
      return '结论：child change checked.';
    }
    if (childId) return 'Collected and verified the delivered file.';
    const reply = await f.ask(ctx, 'delegate', {
      agent: 'Claude A',
      task: 'Independent change in b.txt',
      write: true,
      files: ['b.txt'],
      wait_seconds: 30,
    });
    assert.match(reply, /文件交付已核验/);
    assert.equal(readFileSync(join(f.projectDirectory, 'b.txt'), 'utf8'), 'child b\n');
    return 'Parent verified delivered change.';
  });
  const root = await f.start();
  const result = await finish(f.workspace, root.workflow.id);
  assert.equal(result.status, 'completed', [result.error, ...f.failures].join('\n'));
  const child = f.workspace.store.get<Workflow>('workflow', childId)!;
  assert.equal(child.executionWorkspaceMode, 'isolated');
  assert.ok(workspaceDeliveryComplete(child));
  assert.deepEqual(readFileSync(join(f.projectDirectory, '.git', 'index')), index);
  assert.ok(existsSync(childDirectory));
});

test('nested writers deliver into the direct parent worktree and read-only helpers inherit that root', async (t) => {
  const f = fixture(t);
  let writerDirectory = '';
  let leafDirectory = '';
  const awaitDelivery = async (ctx: ExecuteContext, reply: string) => {
    const [taskId] = ids(reply);
    assert.ok(taskId, reply);
    const deadline = Date.now() + 60_000;
    while (!/文件交付已核验/.test(reply) && Date.now() < deadline) {
      reply = await f.ask(ctx, 'get_result', {
        task_id: taskId,
        wait_seconds: Math.min(5, Math.ceil((deadline - Date.now()) / 1000)),
      });
      if (!/文件交付已核验/.test(reply)) await new Promise((done) => setTimeout(done, 250));
    }
    return reply;
  };
  f.set(async (ctx) => {
    const task = ctx.input.routingPrompt ?? '';
    if (task.startsWith('Read current')) {
      assert.equal(ctx.input.projectPath, writerDirectory);
      assert.equal(ctx.input.permissionMode, 'read-only');
      assert.equal(readFileSync(join(ctx.input.projectPath, 'b.txt'), 'utf8'), 'outer b\n');
      return '结论：reader inspected the child checkout.';
    }
    if (task.startsWith('Nested change')) {
      leafDirectory = ctx.input.projectPath;
      assert.notEqual(leafDirectory, writerDirectory);
      writeFileSync(join(leafDirectory, 'a.txt'), 'nested a\n');
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          itemId: 'nested-write-a',
          kind: 'fileChange',
          status: 'completed',
          input: { changes: [{ path: join(leafDirectory, 'a.txt'), kind: { type: 'update' } }] },
        },
      });
      return '结论：nested edit verified.';
    }
    if (ctx.input.agentChild) {
      writerDirectory = ctx.input.projectPath;
      writeFileSync(join(writerDirectory, 'b.txt'), 'outer b\n');
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          itemId: 'outer-write-b',
          kind: 'fileChange',
          status: 'completed',
          input: { changes: [{ path: join(writerDirectory, 'b.txt'), kind: { type: 'update' } }] },
        },
      });
      assert.match(
        await f.ask(ctx, 'delegate', { agent: 'Codex B', task: 'Read current child checkout', wait_seconds: 30 }),
        /reader inspected/,
      );
      assert.match(
        await awaitDelivery(
          ctx,
          await f.ask(ctx, 'delegate', {
            agent: 'Codex B',
            task: 'Nested change of a.txt',
            write: true,
            files: [join(writerDirectory, 'a.txt')],
            wait_seconds: 30,
          }),
        ),
        /文件交付已核验/,
      );
      assert.equal(readFileSync(join(writerDirectory, 'a.txt'), 'utf8'), 'nested a\n');
      assert.equal(readFileSync(join(f.projectDirectory, 'a.txt'), 'utf8'), 'base a\n');
      return '结论：outer verified nested edit.';
    }
    if (writerDirectory) {
      assert.equal(readFileSync(join(f.projectDirectory, 'a.txt'), 'utf8'), 'nested a\n');
      assert.equal(readFileSync(join(f.projectDirectory, 'b.txt'), 'utf8'), 'outer b\n');
      return 'Collected and verified the delivered nested changes.';
    }
    assert.match(
      await awaitDelivery(
        ctx,
        await f.ask(ctx, 'delegate', {
          agent: 'Claude A',
          task: 'Outer work on a.txt and b.txt',
          write: true,
          files: ['a.txt', 'b.txt'],
          wait_seconds: 45,
        }),
      ),
      /文件交付已核验/,
    );
    return 'Nested changes verified.';
  });
  const root = await f.start();
  const result = await finish(f.workspace, root.workflow.id);
  assert.equal(result.status, 'completed', [result.error, ...f.failures].join('\n'));
  assert.ok(leafDirectory);
  assert.equal(readFileSync(join(f.projectDirectory, 'a.txt'), 'utf8'), 'nested a\n');
  assert.equal(readFileSync(join(f.projectDirectory, 'b.txt'), 'utf8'), 'outer b\n');
});

test('conflicting sibling edits remain in their worktrees and prevent a false completed parent', async (t) => {
  const f = fixture(t);
  const childIds: string[] = [];
  let rootCalls = 0;
  f.set(async (ctx) => {
    if (ctx.input.agentChild) {
      childIds.push(ctx.input.workflowId!);
      writeFileSync(join(ctx.input.projectPath, 'a.txt'), `${ctx.input.routingPrompt}\n`);
      return '结论：local edit ready.';
    }
    if (++rootCalls > 1) return 'Must not accept a conflict as completed.';
    const reply = await f.ask(ctx, 'delegate_many', {
      tasks: [
        { agent: 'Claude A', task: 'First different edit', write: true, files: ['a.txt'] },
        { agent: 'Codex B', task: 'Second conflicting edit', write: true, files: ['a.txt'] },
      ],
    });
    assert.equal(ids(reply).length, 2, reply);
    await f.ask(ctx, 'get_result', { task_ids: ids(reply), wait_seconds: 45 });
    return 'Both workers finished locally.';
  });
  const root = await f.start();
  const result = await finish(f.workspace, root.workflow.id);
  assert.equal(result.status, 'blocked', [result.error, ...f.failures].join('\n'));
  assert.match(result.error ?? '', /尚未交付/);
  const children = childIds.map((id) => f.workspace.store.get<Workflow>('workflow', id)!);
  assert.equal(children.filter((child) => workspaceDeliveryComplete(child)).length, 1);
  assert.equal(children.filter((child) => child.executionWorkspace?.delivery?.status === 'conflict').length, 1);
  assert.ok(children.every((child) => existsSync(child.executionWorkspace!.directory)));
});

test('manual delegation selects a real durable root, is idempotent, and non-Git work is explicitly shared', async (t) => {
  const f = fixture(t, false);
  f.set(async (ctx) => {
    writeFileSync(join(ctx.input.projectPath, 'b.txt'), 'manual change\n');
    ctx.emit({
      at: new Date().toISOString(),
      type: 'tool',
      data: {
        kind: 'fileChange',
        itemId: 'fixture-write',
        status: 'completed',
        input: { changes: [{ path: 'b.txt', kind: { type: 'update' } }] },
      },
    });
    return 'Verified actual file change.';
  });
  const project = await f.workspace.createProject(f.projectDirectory);
  const conversation = f.workspace.createConversation(project.id);
  assert.equal(f.workspace.delegationParent(conversation.id).workflow, undefined);
  const root = await f.workspace.send(conversation.id, {
    content: 'Edit project files',
    mode: 'chat',
    permissionMode: 'workspace-write',
    explicitWrite: true,
    executionPolicy: 'cli-first',
    runtimeId: 'codex-a',
    autoEscalate: false,
  });
  await finish(f.workspace, root.workflow.id);
  assert.equal(f.workspace.delegationParent(conversation.id).workflow?.id, root.workflow.id);
  const first = await f.workspace.delegate(root.workflow.id, 'worker', 'Independent follow-up', 'manual-child');
  const repeated = await f.workspace.delegate(root.workflow.id, 'worker', 'Independent follow-up', 'manual-child');
  assert.equal(repeated.workflow.id, first.workflow.id);
  assert.equal(repeated.reused, true);
  const child = await finish(f.workspace, first.workflow.id);
  assert.equal(child.status, 'completed', child.error ?? '');
  assert.equal(child.executionWorkspaceMode, 'shared');
  assert.equal(child.executionWorkspaceId, undefined);
  assert.equal(f.calls.at(-1)?.input.projectPath, f.projectDirectory);
});

test('a continued child keeps its checkout and delivers only the new attempt, without inheriting the old receipt', async (t) => {
  const f = fixture(t);
  const childAttempts = new Map<string, number>();
  f.set(async (ctx) => {
    if (ctx.input.agentChild) {
      if (!childAttempts.has(ctx.input.workflowId!)) childAttempts.set(ctx.input.workflowId!, childAttempts.size + 1);
      writeFileSync(join(ctx.input.projectPath, 'b.txt'), `attempt ${childAttempts.get(ctx.input.workflowId!)}\n`);
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          kind: 'fileChange',
          itemId: 'continued-write',
          status: 'completed',
          input: { changes: [{ path: 'b.txt', kind: { type: 'update' } }] },
        },
      });
      return '结论：new local file change verified.';
    }
    return 'Project ready for independent work.';
  });
  const root = await f.start();
  await finish(f.workspace, root.workflow.id);
  const child = await f.workspace.delegate(root.workflow.id, 'worker', 'Edit b.txt', 'continued-child');
  const completed = await finish(f.workspace, child.workflow.id);
  assert.equal(completed.status, 'completed', completed.error ?? '');
  const first = await f.workspace.deliverWorkspace(child.workflow.id);
  assert.ok(workspaceDeliveryComplete(first));
  const inspect = ManagedWorktrees.prototype.inspect;
  const interrupted = t.mock.method(
    ManagedWorktrees.prototype,
    'inspect',
    async function (this: ManagedWorktrees, id: string) {
      const record = await inspect.call(this, id);
      return (
        record && {
          ...record,
          delivery: {
            status: 'recovery-required' as const,
            at: new Date().toISOString(),
            changedPaths: ['b.txt'],
            reason: 'synthetic interrupted journal',
          },
        }
      );
    },
  );
  const before = f.workspace.store.conversationWorkflows(root.conversation.id).length;
  await assert.rejects(() => f.workspace.continue(child.workflow.id, 'Continue'), /先核对并重试交付/);
  assert.equal(f.workspace.store.conversationWorkflows(root.conversation.id).length, before);
  assert.equal(f.workspace.store.get<Workflow>('workflow', child.workflow.id)?.followUp, undefined);
  interrupted.mock.restore();
  assert.ok(workspaceDeliveryComplete(await f.workspace.deliverWorkspace(child.workflow.id, true)));
  const next = await f.workspace.continue(child.workflow.id, 'Update b.txt with the next verified change');
  assert.equal(next.workflow.executionWorkspaceId, first.executionWorkspaceId);
  assert.equal(workspaceDeliveryComplete(next.workflow), false);
  const finished = await finish(f.workspace, next.workflow.id);
  assert.equal(finished.status, 'completed', [finished.error, ...f.failures].join('\n'));
  const delivered = await f.workspace.deliverWorkspace(finished.id);
  assert.ok(workspaceDeliveryComplete(delivered));
  assert.equal(delivered.executionWorkspace?.directory, first.executionWorkspace?.directory);
  assert.equal(delivered.executionDeliveryWorkflowId, finished.id);
  assert.equal(readFileSync(join(f.projectDirectory, 'b.txt'), 'utf8'), 'attempt 2\n');
  assert.equal(new Set(f.calls.filter((ctx) => ctx.input.agentChild).map((ctx) => ctx.input.projectPath)).size, 1);
  assert.equal(f.workspace.state().conversations?.find((item) => item.id === root.conversation.id)?.delegationCount, 1);
});

test('cancelling a parent with an isolated writer retains local changes without delivering or starting another turn', async (t) => {
  const f = fixture(t);
  let childId = '';
  f.set(async (ctx) => {
    if (ctx.input.agentChild) {
      childId = ctx.input.workflowId!;
      writeFileSync(join(ctx.input.projectPath, 'b.txt'), 'retained cancelled work\n');
      await new Promise<void>((_done, reject) => {
        if (ctx.signal.aborted) reject(ctx.signal.reason);
        else ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
    }
    await f.ask(ctx, 'delegate', {
      agent: 'Claude A',
      task: 'Edit b.txt then verify',
      write: true,
      files: ['b.txt'],
      wait_seconds: 45,
    });
    return 'Cancelled work cannot complete.';
  });
  const root = await f.start();
  await f.workspace.tickQueue();
  for (let i = 0; !childId && i < 1000; i++) {
    await f.workspace.tickQueue();
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.ok(childId, 'the isolated writer actually started');
  f.workspace.cancel(root.workflow.id);
  const result = await finish(f.workspace, root.workflow.id);
  assert.equal(result.status, 'cancelled');
  const child = await finish(f.workspace, childId);
  assert.equal(child.status, 'cancelled');
  assert.equal(readFileSync(join(child.executionWorkspace!.directory, 'b.txt'), 'utf8'), 'retained cancelled work\n');
  assert.equal(readFileSync(join(f.projectDirectory, 'b.txt'), 'utf8'), 'base b\n');
  assert.equal(workspaceDeliveryComplete(child), false);
  assert.equal(f.calls.length, 2);
  await assert.rejects(() => f.workspace.deliverWorkspace(childId, true), /尚未成功完成/);
});

test('out-of-scope child changes remain isolated and cannot be delivered by the manual retry route', async (t) => {
  const f = fixture(t);
  let childId = '';
  f.set(async (ctx) => {
    if (ctx.input.agentChild) {
      childId = ctx.input.workflowId!;
      writeFileSync(join(ctx.input.projectPath, 'b.txt'), 'outside declared scope\n');
      return '结论：local work ended.';
    }
    await f.ask(ctx, 'delegate', {
      agent: 'Claude A',
      task: 'Edit only a.txt',
      write: true,
      files: ['a.txt'],
      wait_seconds: 30,
    });
    return 'Review scope before completion.';
  });
  const root = await f.start();
  const result = await finish(f.workspace, root.workflow.id);
  assert.equal(result.status, 'blocked', result.error ?? '');
  const child = await f.workspace.deliverWorkspace(childId, true);
  assert.deepEqual(child.delegation?.outOfScope, ['b.txt']);
  assert.match(child.deliveryPendingReason ?? '', /超出声明范围/);
  assert.equal(workspaceDeliveryComplete(child), false);
  assert.equal(readFileSync(join(f.projectDirectory, 'b.txt'), 'utf8'), 'base b\n');
});

test('a checked file delivery prevents the parked parent from resuming until the physical lease is released', async (t) => {
  const f = fixture(t, false);
  let nativeStarted = false;
  let releaseNative!: () => void;
  const native = new Promise<void>((done) => {
    releaseNative = done;
  });
  f.set(async () => {
    nativeStarted = true;
    await native;
    return 'Verified.';
  });
  const root = await f.start();
  for (let i = 0; !nativeStarted && i < 1000; i++) {
    await f.workspace.tickQueue();
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.ok(nativeStarted);
  const runId = f.controller.activeRunFor(root.workflow.id)!;
  const resume = f.controller.suspendExecution(runId);
  await assert.rejects(
    () => f.controller.deliverProject(f.projectDirectory, 'unrelated-owner', async () => {}),
    /另一个任务占用/,
  );
  let releaseDelivery!: () => void;
  const held = new Promise<void>((done) => {
    releaseDelivery = done;
  });
  const delivery = f.controller.deliverProject(f.projectDirectory, root.workflow.id, () => held);
  let resumed = false;
  const restoring = resume().then(() => {
    resumed = true;
  });
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(resumed, false);
  assert.equal(f.controller.writerExecuting(f.projectDirectory), true);
  releaseDelivery();
  await delivery;
  await restoring;
  assert.equal(resumed, true);
  releaseNative();
  await finish(f.workspace, root.workflow.id);
});
