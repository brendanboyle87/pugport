import { settledWorkflow as finish, workflowState, fixtureSignal } from './helpers/workflow-state.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync } from '../src/server/platform/test-process.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { changedBetween, dirtyFiles } from '../src/server/scope-check.ts';
import { normalizeScope, scopesOverlap, sideBySide, withinScope } from '../src/shared/scope.ts';
import type { ExecuteContext, ExecuteResult, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

test('scopes: paths normalize, folders contain their files, overlap is symmetric', () => {
  assert.deepEqual(normalizeScope(['src\\ui\\', './src/engine/**', 'src/ui']), ['src/ui', 'src/engine']);
  assert.deepEqual(normalizeScope(['.', 'src']), ['']);
  assert.ok(withinScope('src/ui/App.tsx', ['src/ui']));
  assert.ok(withinScope('SRC/UI/App.tsx', ['src/ui']), 'Windows paths ignore case');
  assert.ok(!withinScope('src/uikit/a.ts', ['src/ui']), 'a folder is not a name prefix');
  assert.ok(scopesOverlap(['src'], ['src/ui/App.tsx']) && scopesOverlap(['src/ui/App.tsx'], ['src']));
  assert.ok(!scopesOverlap(['src/engine'], ['src/ui', 'tests/ui.test.ts']));
  assert.ok(scopesOverlap([''], ['anything']));
  const share = (callerId: string, scope: string[]) => ({ callerId, scope });
  assert.ok(
    sideBySide({ workflowId: 'caller' }, { workflowId: 'a', share: share('caller', ['']) }),
    'a caller beside its own sub-task',
  );
  assert.ok(sideBySide({ share: share('caller', ['ch1.md']) }, { share: share('caller', ['ch2.md']) }));
  assert.ok(
    !sideBySide({ share: share('caller', ['book']) }, { share: share('caller', ['book/ch2.md']) }),
    'overlapping files take turns',
  );
  assert.ok(
    !sideBySide({ share: share('a', ['ch1.md']) }, { share: share('b', ['ch2.md']) }),
    'different callers take turns',
  );
  assert.ok(!sideBySide({ workflowId: 'x' }, { workflowId: 'y' }), 'unrelated writers take turns');
});

test('git snapshots tell which files changed in between', async (t) => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'scope-snapshot-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'already.txt'), 'dirty before');
  writeFileSync(join(repo, 'same-tick.txt'), 'before');
  const before = (await dirtyFiles(repo))!;
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'new.ts'), 'x');
  writeFileSync(join(repo, 'already.txt'), 'edited again');
  const changedTime = new Date(before.get('already.txt')! + 2000);
  utimesSync(join(repo, 'already.txt'), changedTime, changedTime);
  writeFileSync(join(repo, 'same-tick.txt'), 'edited');
  const frozenTime = new Date(before.get('same-tick.txt')!);
  utimesSync(join(repo, 'same-tick.txt'), frozenTime, frozenTime);
  const after = (await dirtyFiles(repo))!;
  assert.deepEqual(changedBetween(before, after).sort(), ['already.txt', 'same-tick.txt', 'src/new.ts']);
  assert.equal(await dirtyFiles(join(repo, 'not-a-repo')), undefined);
});

const card = (id: string, provider: RuntimeTarget['provider'], label: string): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled: true,
});

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'file-scope-test-')));
  const directory = join(root, 'project');
  mkdirSync(directory);
  execFileSync('git', ['init', '-q', directory]);
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'base',
    ],
    { cwd: directory },
  );
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(root, 'data', 'memory');
  const controller = new Controller(root, join(root, 'data'));
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    cpus: 16,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpuPercent: 20,
  }));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.routePreferencesEnabled = true;
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = [
    card('codex', 'codex', 'Codex B'),
    card('claude', 'claude', 'Claude · 本机'),
    card('grok', 'grok', 'Grok · 本机'),
  ];
  controller.snapshots = controller.targets.map((target): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  t.mock.method(controller, 'refresh', async () => {});
  const behavior: Partial<Record<RuntimeTarget['provider'], (ctx: ExecuteContext) => Promise<string>>> = {};
  const execute = async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    ctx.registerSteer?.(async () => {});
    const run = behavior[ctx.target.provider];
    return { output: run ? await run(ctx) : `${ctx.target.label} answer`, nativeSessionId: 'session' };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  t.mock.method(grokAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    const target = resolve(root);
    assert.ok(
      target.startsWith(realpathSync.native(tmpdir()) + sep) && basename(target).startsWith('file-scope-test-'),
    );
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { workspace, controller, behavior, bridge, directory };
}

const ask = (bridge: AgentBridge, ctx: ExecuteContext, name: string, args: Record<string, unknown>) =>
  bridge
    .handle(`Bearer ${ctx.agentBridge!.token}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    .then((reply) => (reply.body as { result: { content: { text: string }[] } }).result.content[0]!.text);

test('sub-tasks with separate files write at once beside their caller, and a file outside both is reported', async (t) => {
  const f = fixture(t);
  let activeWriters = 0,
    peakWriters = 0,
    writersAfterShortWait = -1;
  const writersReady = fixtureSignal();
  const releaseWriters = fixtureSignal();
  t.after(() => releaseWriters.resolve());
  const shared = join(f.directory, 'shared.txt');
  writeFileSync(shared, '');
  const childDirectories = new Set<string>();
  for (const provider of ['claude', 'grok'] as const)
    f.behavior[provider] = async (ctx) => {
      childDirectories.add(ctx.input.projectPath!);
      peakWriters = Math.max(peakWriters, ++activeWriters);
      if (activeWriters === 2) writersReady.resolve();
      try {
        await releaseWriters.promise;
        mkdirSync(join(ctx.input.projectPath!, 'src', provider), { recursive: true });
        writeFileSync(join(ctx.input.projectPath!, 'src', provider, 'index.ts'), provider);
        // Each isolated worker edits its own copy, but the out-of-scope change must still block delivery.
        const childShared = join(ctx.input.projectPath!, 'shared.txt');
        writeFileSync(childShared, `${readFileSync(childShared, 'utf8')}${provider}\n`);
        return `${provider} done`;
      } finally {
        activeWriters--;
      }
    };
  let early = '',
    results = '';
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    const created = await Promise.all([
      ask(f.bridge, ctx, 'delegate', {
        agent: 'Claude 本机',
        task: 'Engine',
        write: true,
        files: ['src/claude'],
        wait_seconds: 0,
      }),
      ask(f.bridge, ctx, 'delegate', {
        agent: 'Grok 本机',
        task: 'UI',
        write: true,
        files: ['src/grok'],
        wait_seconds: 0,
      }),
    ]);
    const ids = created.map((reply) => reply.match(/task_id: ([0-9a-f-]{36})/)![1]!);
    await writersReady.promise;
    // A wait that ends while its sub-tasks still write hands the caller its turn back at once.
    early = await ask(f.bridge, ctx, 'get_result', { task_ids: ids, wait_seconds: 0.05 });
    writersAfterShortWait = activeWriters;
    releaseWriters.resolve();
    results = await ask(f.bridge, ctx, 'get_result', { task_ids: ids, wait_seconds: 30 });
    return 'integrated';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, {
    content: 'Build with independent workers',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'blocked');
  assert.equal(peakWriters, 2, 'separate files are written at the same time');
  assert.equal(childDirectories.size, 2);
  assert.ok(!childDirectories.has(f.directory));
  assert.equal(writersAfterShortWait, 2);
  assert.doesNotMatch(early, /恢复执行资源超时/);
  assert.match(results, /Claude · 本机 已完成[\s\S]*Grok · 本机 已完成/);
  // A sibling's own files are not reported against the other; the file outside both is, for each.
  assert.doesNotMatch(results, /index\.ts/);
  assert.equal(results.match(/之外有这些文件被改动：shared\.txt/g)?.length, 2);
  assert.equal(results.match(/文件尚未交付到父任务/g)?.length, 2);
  assert.equal(readFileSync(shared, 'utf8'), '');
  assert.equal(existsSync(join(f.directory, 'src')), false, 'rejected deliveries leave all parent files unchanged');
});

test('a writing sub-task starts while its caller keeps working', async (t) => {
  const f = fixture(t);
  let childStarted = false;
  let childId = '';
  const deliveredFile = join(f.directory, 'src', 'engine', 'index.ts');
  f.behavior.claude = async (ctx) => {
    childStarted = true;
    mkdirSync(join(ctx.input.projectPath!, 'src', 'engine'), { recursive: true });
    writeFileSync(join(ctx.input.projectPath!, 'src', 'engine', 'index.ts'), 'export const engine = 1;');
    return 'child done';
  };
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    if (childId) {
      assert.equal(readFileSync(deliveredFile, 'utf8'), 'export const engine = 1;');
      return 'Verified the delivered engine.';
    }
    const reply = await ask(f.bridge, ctx, 'delegate', {
      agent: 'Claude 本机',
      task: 'Engine',
      write: true,
      files: ['src/engine'],
      wait_seconds: 0,
    });
    childId = reply.match(/task_id: ([0-9a-f-]{36})/)![1]!;
    await workflowState(f.workspace, () => childStarted);
    assert.equal(childStarted, true, 'the caller does not have to stop for its own sub-task');
    assert.equal(existsSync(deliveredFile), false, 'child writes do not reach the actively writing caller');
    const result = await ask(f.bridge, ctx, 'get_result', { task_id: childId, wait_seconds: 30 });
    assert.match(result, /^Claude · 本机 已完成/);
    assert.match(result, /文件交付已核验/);
    assert.equal(readFileSync(deliveredFile, 'utf8'), 'export const engine = 1;');
    return 'integrated';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, {
    content: 'Build with a worker',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  const settled = await finish(f.workspace, parent.workflow.id);
  assert.equal(settled.status, 'completed', settled.error ?? 'The caller should finish after checked child delivery.');
  assert.equal(childStarted, true);
});

test('writing subtasks declare their files, isolated overlapping scopes run together, and edits outside block delivery', async (t) => {
  const f = fixture(t);
  const timeline: string[] = [];
  const releaseFirst = fixtureSignal();
  const bothStarted = fixtureSignal();
  t.after(() => {
    releaseFirst.resolve();
    bothStarted.resolve();
  });
  const childDirectories = new Set<string>();
  const started = (ctx: ExecuteContext, provider: string) => {
    childDirectories.add(ctx.input.projectPath!);
    timeline.push(`${provider} start`);
    if (childDirectories.size === 2) bothStarted.resolve();
  };
  f.behavior.claude = async (ctx) => {
    started(ctx, 'claude');
    await releaseFirst.promise;
    mkdirSync(join(ctx.input.projectPath!, 'src', 'engine'), { recursive: true });
    writeFileSync(join(ctx.input.projectPath!, 'src', 'engine', 'board.ts'), 'export const board = 1;');
    // Outside its declared files.
    writeFileSync(join(ctx.input.projectPath!, 'README.md'), 'changed by the engine worker');
    timeline.push('claude end');
    assert.match(ctx.input.prompt, /只修改这些文件或目录：src\/engine/);
    return 'engine done';
  };
  f.behavior.grok = async (ctx) => {
    started(ctx, 'grok');
    await releaseFirst.promise;
    mkdirSync(join(ctx.input.projectPath!, 'src', 'engine'), { recursive: true });
    writeFileSync(join(ctx.input.projectPath!, 'src', 'engine', 'rules.ts'), 'export const rules = 1;');
    timeline.push('grok end');
    return 'rules done';
  };
  let missing = '',
    first = '',
    second = '';
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    missing = await ask(f.bridge, ctx, 'delegate', { agent: 'Claude 本机', task: 'Write the engine', write: true });
    const a = await ask(f.bridge, ctx, 'delegate', {
      agent: 'Claude 本机',
      task: 'Write the engine',
      write: true,
      files: ['src/engine'],
      wait_seconds: 0,
    });
    const b = await ask(f.bridge, ctx, 'delegate', {
      agent: 'Grok 本机',
      task: 'Write the rules',
      write: true,
      files: ['src\\engine\\rules.ts'],
      wait_seconds: 0,
    });
    await bothStarted.promise;
    releaseFirst.resolve();
    const results = await ask(f.bridge, ctx, 'get_result', {
      task_ids: [a, b].map((reply) => reply.match(/task_id: ([0-9a-f-]{36})/)![1]!),
      wait_seconds: 30,
    });
    [first, second] = results.split('\n\n---\n\n') as [string, string];
    return 'integrated';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, {
    content: 'Build it with two workers',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'blocked');
  assert.match(missing, /请用 files 列出它要改的文件或目录/);
  assert.deepEqual(timeline.slice(0, 2).sort(), ['claude start', 'grok start']);
  assert.ok(!childDirectories.has(f.directory));
  assert.match(first, /engine done[\s\S]*声明范围（src\/engine）之外有这些文件被改动：README\.md/);
  assert.doesNotMatch(first, /board\.ts/);
  assert.doesNotMatch(second, /被改动/);
  assert.match(first, /文件尚未交付到父任务/);
  assert.match(second, /文件交付已核验/);
  assert.equal(existsSync(join(f.directory, 'README.md')), false);
  assert.equal(existsSync(join(f.directory, 'src', 'engine', 'board.ts')), false);
  assert.equal(readFileSync(join(f.directory, 'src', 'engine', 'rules.ts'), 'utf8'), 'export const rules = 1;');
  const children = f.workspace.store
    .list<Workflow>('workflow', conversation.id, 50)
    .filter((workflow) => workflow.delegation?.scope);
  assert.deepEqual(children.map((child) => child.delegation!.scope).sort(), [['src/engine'], ['src/engine/rules.ts']]);
});

test('files outside the project are refused', async (t) => {
  const f = fixture(t);
  let reply = '';
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    reply = await ask(f.bridge, ctx, 'delegate', {
      agent: 'Claude 本机',
      task: 'Edit elsewhere',
      write: true,
      files: ['../other/secret.txt'],
    });
    return 'ok';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, {
    content: 'Try to edit outside',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  await finish(f.workspace, parent.workflow.id);
  assert.match(reply, /不能用 \.\. 跳出项目目录/);
});

test('subtasks report progress; three reports stuck on the same problem stop them and tell the user', async (t) => {
  const f = fixture(t);
  const replies: string[] = [];
  let midway = '';
  const reported = fixtureSignal();
  const inspected = fixtureSignal();
  f.behavior.claude = async (ctx) => {
    replies.push(await ask(f.bridge, ctx, 'report_progress', { progress: 'Read the engine', next: 'Write tests' }));
    reported.resolve();
    await inspected.promise;
    for (let i = 0; i < 3; i++)
      replies.push(
        await ask(f.bridge, ctx, 'report_progress', {
          progress: 'Tried again',
          blocker: i === 1 ? 'The test runner is missing!' : 'the test runner is missing',
        }),
      );
    return 'stuck on the test runner';
  };
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    const started = await ask(f.bridge, ctx, 'delegate', { agent: 'Claude 本机', task: 'Add tests', wait_seconds: 0 });
    const id = started.match(/task_id: ([0-9a-f-]{36})/)![1]!;
    await reported.promise;
    midway = await ask(f.bridge, ctx, 'get_result', { task_id: id, wait_seconds: 0 });
    inspected.resolve();
    await ask(f.bridge, ctx, 'get_result', { task_id: id, wait_seconds: 30 });
    return 'done';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, {
    content: 'Delegate the tests',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  await finish(f.workspace, parent.workflow.id);
  assert.deepEqual(replies.slice(0, 3), ['已记录。', '已记录。', '已记录。']);
  assert.match(replies[3]!, /连续卡住 3 次，PugPort 已停下这个子任务/);
  const child = f.workspace.store
    .list<Workflow>('workflow', conversation.id, 50)
    .find((workflow) => workflow.delegation?.parentId === parent.workflow.id)!;
  assert.equal(child.delegation!.checkpoints!.length, 4);
  assert.deepEqual(child.delegation!.checkpoints![0], {
    ...child.delegation!.checkpoints![0],
    progress: 'Read the engine',
    next: 'Write tests',
  });
  // The caller saw the report, not raw output; the user was told what it is stuck on.
  assert.match(midway, /最近报告：已完成 (Read the engine|Tried again)/);
  const messages = f.workspace.conversation(conversation.id).messages;
  assert.ok(
    messages.some((message) =>
      /连续卡住 3 次，已停下这个子任务[\s\S]*the test runner is missing/.test(message.content),
    ),
  );
});
