import { idleMachineReading } from './helpers/machine-reading.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { settledWorkflow } from './helpers/workflow-state.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { ConversationAutomation } from '../src/server/conversation-automation.ts';
import { ProjectCliContextService } from '../src/server/project-cli-context.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { canUseConversationCollaboration } from '../src/shared/conversation-collaboration.ts';
import { canAttachMod } from '../src/shared/conversation-modes.ts';
import type {
  Conversation,
  ExecuteContext,
  ExecuteResult,
  Project,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-project-integration-'))),
    directory = join(root, 'project');
  mkdirSync(directory);
  writeFileSync(join(directory, 'file.txt'), 'committed base\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'base');
  const controller = new Controller(root, join(root, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = ['fixture-a', 'fixture-b'].map(
    (id) =>
      ({
        id,
        provider: 'codex',
        label: id,
        command: 'NEVER_EXECUTE_REAL_CLI',
        environment: 'native',
        enabled: true,
      }) as RuntimeTarget,
  );
  controller.snapshots = controller.targets.map((target): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Synthetic', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'week', usedPercent: 5, resetsAt: new Date(Date.now() + 7200000).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(controller, 'machineReading', idleMachineReading);
  const calls: ExecuteContext[] = [];
  const failures: string[] = [];
  let behavior = async (_context: ExecuteContext) => 'Synthetic answer complete.';
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext): Promise<ExecuteResult> => {
    // Let the scheduler persist the run binding before the synthetic executor calls bridge tools.
    await new Promise<void>((resolve) => setImmediate(resolve));
    calls.push(context);
    try {
      return { output: await behavior(context), nativeSessionId: `fixture-${calls.length}` };
    } catch (error) {
      failures.push(String(error));
      throw error;
    }
  });
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  const cliContext = new ProjectCliContextService(workspace.store);
  workspace.projectCliContext = cliContext;
  const work = new ConversationAutomation(workspace, {
    pull: async () => {
      throw Error('No external CI request permitted');
    },
  });
  t.after(async () => {
    await bridge.close();
    await work.close();
    await cliContext.close();
    await workspace.close();
    await controller.close();
    assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(root).startsWith('pugport-project-integration-'));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    workspace,
    work,
    controller,
    root,
    directory,
    git,
    calls,
    failures,
    ask: async (context: ExecuteContext, name: string, args: Record<string, unknown>) => {
      const reply = await bridge.handle(`Bearer ${context.agentBridge!.token}`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      return (reply.body as { result: { content: { text: string }[] } }).result.content
        .map((block) => block.text)
        .join('\n');
    },
    setBehavior: (next: typeof behavior) => {
      behavior = next;
    },
  };
}
async function finish(workspace: Workspace, id: string) {
  const workflow = await settledWorkflow(workspace, id);
  await workspace.scopeChecked(id);
  return workflow;
}
const input = (content: string, write = false) => ({
  content,
  mode: 'chat' as const,
  permissionMode: write ? ('workspace-write' as const) : ('read-only' as const),
  explicitWrite: write,
  executionPolicy: 'cli-first' as const,
  autoEscalate: false,
});

async function laneFixture(t: TestContext) {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const parent = f.workspace.createConversation(project.id);
  const source = await f.workspace.send(parent.id, input('Explain the synthetic code.'));
  assert.equal((await finish(f.workspace, source.workflow.id)).status, 'completed');
  const lane = await f.work.createLane(
    { conversationId: parent.id, source: 'human', write: true },
    { requestId: randomUUID(), title: 'Synthetic child isolation lane', write: true },
  );
  const laneDirectory = await f.workspace.conversationExecutionPath(lane.id);
  assert.ok(lane.lane?.workspaceId);
  assert.equal(lane.childWorkspaceMode, 'branch');
  return { ...f, project, lane, laneDirectory };
}

test(
  'lane write children isolate branches at the lane HEAD while read-only children inherit',
  { timeout: 120000 },
  async (t) => {
    const f = await laneFixture(t);
    f.git('config', 'user.name', 'Synthetic');
    f.git('config', 'user.email', 'synthetic@example.invalid');
    const children: string[] = [];
    let laneHead = '';
    f.setBehavior(async (context) => {
      const workflow = f.workspace.store.get<Workflow>('workflow', context.input.workflowId!)!;
      if (workflow.delegation) {
        if (workflow.input.permissionMode === 'read-only') {
          assert.equal(workflow.inheritedExecutionWorkspace, true);
          assert.equal(workflow.executionWorkspaceMode, 'inherited');
          assert.equal(context.input.projectPath, f.laneDirectory);
          return 'Synthetic reader inspected the lane.';
        }
        assert.equal(workflow.executionWorkspaceId, workflow.id);
        assert.equal(workflow.executionWorkspace?.mode, 'branch');
        assert.equal(workflow.executionWorkspace.baseCommit, laneHead);
        assert.equal(workflow.executionWorkspace.sourceDirectory, f.laneDirectory);
        assert.notEqual(context.input.projectPath, f.laneDirectory);
        assert.equal(readFileSync(join(context.input.projectPath, 'lane-base.txt'), 'utf8'), 'lane baseline\n');
        const file = workflow.delegation.scope![0]!;
        writeFileSync(join(context.input.projectPath, file), 'child-only change\n');
        context.emit({
          at: new Date().toISOString(),
          type: 'tool',
          data: {
            kind: 'fileChange',
            itemId: 'synthetic-child-write',
            status: 'completed',
            input: { changes: [{ path: file, kind: { type: 'add' } }] },
          },
        });
        const committed = await f.ask(context, 'commit_branch', { message: `Synthetic child ${file}`, paths: [file] });
        assert.match(committed, /"status":"committed"/);
        assert.equal(existsSync(join(f.laneDirectory, file)), false);
        return 'Synthetic branch committed independently.';
      }
      writeFileSync(join(f.laneDirectory, 'lane-base.txt'), 'lane baseline\n');
      const committed = await f.ask(context, 'commit_branch', {
        message: 'Synthetic lane baseline',
        paths: ['lane-base.txt'],
      });
      assert.match(committed, /"status":"committed"/);
      laneHead = f.git('-C', f.laneDirectory, 'rev-parse', 'HEAD');
      assert.notEqual(laneHead, f.git('rev-parse', 'HEAD'));
      const batch = await f.workspace.delegateBatch(
        workflow.id,
        ['one.txt', 'two.txt'].map((file, i) => ({
          id: `writer-${i}`,
          dependsOn: [],
          agent: { label: 'Synthetic writer', runtimeId: 'fixture-b', provider: 'codex' },
          task: `Implement ${file}`,
          options: { write: true, files: [file] },
        })),
      );
      children.push(...batch.map((child) => child.workflow.id));
      await f.ask(context, 'get_result', { task_ids: children, wait_seconds: 45 });
      const reader = await f.workspace.delegateToAgent(
        workflow.id,
        { label: 'Synthetic reader', runtimeId: 'fixture-b', provider: 'codex' },
        'Read the lane files',
      );
      children.push(reader.workflow.id);
      await f.ask(context, 'get_result', { task_ids: [reader.workflow.id], wait_seconds: 30 });
      return 'Synthetic lane checked isolated children.';
    });
    const sent = await f.workspace.send(f.lane.id, input('Implement independent code changes.', true));
    const turn = await finish(f.workspace, sent.workflow.id);
    assert.equal(turn.status, 'completed', [turn.error, ...f.failures].join('\n'));
    assert.equal(children.length, 3);
    const results = await Promise.all(children.map((id) => finish(f.workspace, id)));
    for (const child of results) assert.equal(child.status, 'completed', [child.error, ...f.failures].join('\n'));
    assert.notEqual(results[0]!.executionWorkspace!.directory, results[1]!.executionWorkspace!.directory);
    for (const child of results.slice(0, 2)) {
      assert.equal(child.executionWorkspaceId, child.id);
      assert.notEqual(f.git('-C', child.executionWorkspace!.directory, 'rev-parse', 'HEAD'), laneHead);
    }
    assert.equal(existsSync(join(f.laneDirectory, 'one.txt')), false);
    assert.equal(existsSync(join(f.laneDirectory, 'two.txt')), false);
    assert.equal(f.git('-C', f.laneDirectory, 'rev-parse', 'HEAD'), laneHead);
    assert.equal(
      f.workspace.store.get<Conversation>('conversation', f.lane.id)!.lane!.workspaceId,
      f.lane.lane!.workspaceId,
    );
    assert.deepEqual(f.failures, []);
  },
);

test('legacy lane-bound write children block and read-only children run inherited', { timeout: 120000 }, async (t) => {
  const f = await laneFixture(t);
  const sent = await f.workspace.send(f.lane.id, input('Implement the synthetic lane task.', true));
  const parent = await finish(f.workspace, sent.workflow.id);
  assert.equal(parent.status, 'completed', parent.error ?? '');
  for (const write of [true, false]) {
    const child = await f.workspace.send(f.lane.id, input('Inspect synthetic legacy code.', write), undefined, {
      parentId: parent.id,
      role: write ? 'worker' : 'scout',
      requestId: randomUUID(),
      agent: { label: 'Synthetic legacy child', runtimeId: 'fixture-b', provider: 'codex' },
      ...(write ? { scope: ['legacy.txt'] } : {}),
    });
    const stored = f.workspace.store.get<Workflow>('workflow', child.workflow.id)!;
    stored.executionWorkspaceId = f.lane.lane!.workspaceId;
    stored.executionWorkspaceMode = 'isolated';
    stored.executionWorkspace = parent.executionWorkspace;
    f.workspace.store.save('workflow', stored.id, stored.conversationId, stored);
    const result = await finish(f.workspace, stored.id);
    assert.equal(result.status, write ? 'blocked' : 'completed', result.error ?? '');
    if (write) {
      assert.equal(result.error, '子任务记录绑定了工作线目录，请重新派发。');
      assert.equal(
        f.calls.some((call) => call.input.workflowId === result.id),
        false,
      );
    } else {
      assert.equal(result.inheritedExecutionWorkspace, true);
      assert.equal(result.executionWorkspaceMode, 'inherited');
      assert.equal(f.calls.find((call) => call.input.workflowId === result.id)?.input.projectPath, f.laneDirectory);
    }
  }
  assert.equal(
    f.workspace.store.get<Conversation>('conversation', f.lane.id)!.lane!.workspaceId,
    f.lane.lane!.workspaceId,
  );
});

test(
  'device and external children bypass lane paths; unbound lane children preserve their selected workspace mode',
  { timeout: 120000 },
  async (t) => {
    const f = await laneFixture(t);
    const sent = await f.workspace.send(f.lane.id, input('Implement the synthetic lane task.', true));
    const parent = await finish(f.workspace, sent.workflow.id);
    assert.equal(parent.status, 'completed', parent.error ?? '');
    const internal = f.workspace as unknown as {
      prepareExecutionWorkspace(workflow: Workflow, project: Project): Promise<void>;
    };
    for (const kind of ['device', 'external', 'branch', 'snapshot'] as const) {
      const child: Workflow = {
        ...structuredClone(parent),
        id: randomUUID(),
        status: 'queued',
        executionWorkspaceId: undefined,
        executionWorkspace: undefined,
        executionWorkspaceMode: undefined,
        input: {
          ...input('Synthetic path selection.', kind === 'branch' || kind === 'snapshot'),
          deviceId: kind === 'device' ? 'synthetic-device' : undefined,
          childWorkspaceMode: kind === 'snapshot' ? 'snapshot' : 'branch',
        },
        delegation: {
          parentId: parent.id,
          role: 'worker',
          requestId: randomUUID(),
          agent: { label: 'Synthetic child', externalAgentId: kind === 'external' ? 'muse' : undefined },
        },
      };
      if (kind === 'branch' || kind === 'snapshot') {
        const conversation = f.workspace.store.get<Conversation>('conversation', f.lane.id)!;
        delete conversation.lane!.workspaceId;
        f.workspace.store.save('conversation', conversation.id, conversation.projectId, conversation);
      }
      f.workspace.store.save('workflow', child.id, child.conversationId, child);
      await internal.prepareExecutionWorkspace(child, f.project);
      if (kind === 'device' || kind === 'external') {
        assert.equal(child.executionWorkspaceId, undefined);
        assert.equal(child.executionWorkspace, undefined);
        assert.equal(f.workspace.executionPath(child), f.project.path);
      } else {
        assert.equal(child.executionWorkspaceId, child.id);
        assert.equal(child.executionWorkspace?.mode, kind);
        assert.equal(child.executionWorkspace.sourceDirectory, f.laneDirectory);
        assert.notEqual(f.workspace.executionPath(child), f.laneDirectory);
        assert.equal(f.workspace.store.get<Conversation>('conversation', f.lane.id)!.lane!.workspaceId, undefined);
      }
    }
  },
);

for (const outsideScope of [false, true]) {
  test(
    `lane snapshot child ${outsideScope ? 'refuses out-of-scope delivery' : 'delivers into the lane directory'}`,
    { timeout: 120000 },
    async (t) => {
      const f = await laneFixture(t);
      let childId = '';
      f.setBehavior(async (context) => {
        const workflow = f.workspace.store.get<Workflow>('workflow', context.input.workflowId!)!;
        if (workflow.delegation) {
          assert.equal(workflow.executionWorkspaceId, workflow.id);
          assert.equal(workflow.executionWorkspace?.mode, 'snapshot');
          assert.equal(workflow.executionWorkspace.sourceDirectory, f.laneDirectory);
          assert.notEqual(context.input.projectPath, f.laneDirectory);
          assert.equal(readFileSync(join(context.input.projectPath, 'file.txt'), 'utf8'), 'dirty lane baseline\n');
          const file = outsideScope ? 'outside.txt' : 'snapshot.txt';
          writeFileSync(join(context.input.projectPath, file), 'snapshot child change\n');
          context.emit({
            at: new Date().toISOString(),
            type: 'tool',
            data: {
              kind: 'fileChange',
              itemId: 'synthetic-snapshot-write',
              status: 'completed',
              input: { changes: [{ path: file, kind: { type: 'add' } }] },
            },
          });
          assert.equal(existsSync(join(f.laneDirectory, file)), false);
          return 'Synthetic snapshot change ready for scope checks.';
        }
        if (childId) return 'Synthetic snapshot result checked.';
        writeFileSync(join(f.laneDirectory, 'file.txt'), 'dirty lane baseline\n');
        const child = await f.workspace.delegateToAgent(
          workflow.id,
          { label: 'Synthetic snapshot child', runtimeId: 'fixture-b', provider: 'codex' },
          'Implement the snapshot file',
          { write: true, files: ['snapshot.txt'], workspaceMode: 'snapshot' },
        );
        childId = child.workflow.id;
        await f.ask(context, 'get_result', { task_ids: [childId], wait_seconds: 45 });
        return 'Synthetic snapshot result checked.';
      });
      const sent = await f.workspace.send(f.lane.id, input('Implement a synthetic snapshot change.', true));
      const turn = await finish(f.workspace, sent.workflow.id);
      const child = await finish(f.workspace, childId);
      assert.equal(turn.status, outsideScope ? 'blocked' : 'completed', [turn.error, ...f.failures].join('\n'));
      if (outsideScope) {
        assert.match(child.deliveryPendingReason ?? '', /超出声明范围/);
        assert.equal(existsSync(join(f.laneDirectory, 'outside.txt')), false);
      } else {
        assert.equal(child.executionWorkspace?.delivery?.status, 'applied');
        assert.equal(readFileSync(join(f.laneDirectory, 'snapshot.txt'), 'utf8'), 'snapshot child change\n');
      }
      assert.equal(readFileSync(join(f.directory, 'file.txt'), 'utf8'), 'committed base\n');
      assert.equal(existsSync(join(f.directory, 'snapshot.txt')), false);
      assert.equal(
        f.workspace.store.get<Conversation>('conversation', f.lane.id)!.lane!.workspaceId,
        f.lane.lane!.workspaceId,
      );
      assert.deepEqual(f.failures, []);
    },
  );
}

test(
  'long-lived lane uses committed branch baseline, reuses one directory across turns and retains project routing; completion wakes parent read-only once',
  { timeout: 120000 },
  async (t) => {
    const f = fixture(t),
      project = await f.workspace.createProject(f.directory),
      parent = f.workspace.createConversation(project.id);
    const profile = randomUUID();
    f.controller.settings.routingProfiles = [
      {
        id: profile,
        name: 'Project route',
        rules: {
          version: 2,
          text: 'Use fixture B',
          rules: [
            {
              id: 'other',
              category: 'code',
              candidates: [{ runtimeId: 'fixture-b' }],
              strict: true,
              enabled: true,
              source: 'manual',
            },
          ],
          unparsed: [],
          updatedAt: new Date().toISOString(),
        },
      },
    ];
    f.workspace.updateProject(project.id, { routingProfileId: profile });
    const source = await f.workspace.send(parent.id, input('Explain the synthetic code function.'));
    assert.equal((await finish(f.workspace, source.workflow.id)).status, 'completed');
    const base = f.git('rev-parse', 'HEAD');
    writeFileSync(join(f.directory, 'file.txt'), 'parent staged change\n');
    f.git('add', 'file.txt');
    const parentIndex = readFileSync(join(f.directory, '.git', 'index'));
    writeFileSync(join(f.directory, 'file.txt'), 'parent unstaged change\n');
    let laneId = '',
      executions = 0,
      laneDirectory = '';
    f.setBehavior(async (context) => {
      if (f.workspace.store.get<Workflow>('workflow', context.input.workflowId ?? '')?.conversationId === laneId) {
        executions++;
        assert.equal(context.target.id, 'fixture-b');
        assert.ok(context.input.projectPath);
        assert.notEqual(context.input.projectPath, f.directory);
        if (!laneDirectory) {
          laneDirectory = context.input.projectPath;
          assert.equal(readFileSync(join(laneDirectory, 'file.txt'), 'utf8'), 'committed base\n');
        }
        assert.equal(context.input.projectPath, laneDirectory);
        if (executions === 1) writeFileSync(join(laneDirectory, 'lane.txt'), 'first lane work\n');
        else assert.equal(readFileSync(join(laneDirectory, 'lane.txt'), 'utf8'), 'first lane work\n');
      }
      return 'Synthetic independent result; parent must verify.';
    });
    const request = { requestId: randomUUID(), title: 'Durable lane', write: true };
    const actor = { conversationId: parent.id, source: 'human' as const, write: true };
    const lane = await f.work.createLane(actor, request);
    laneId = lane.id;
    assert.ok(lane.lane?.workspaceId);
    assert.equal((await f.work.createLane(actor, request)).id, lane.id);
    const initialPath = await f.workspace.conversationExecutionPath(lane.id);
    const one = await f.workspace.send(lane.id, input('Implement the first code function.', true));
    const first = await finish(f.workspace, one.workflow.id);
    assert.equal(first.status, 'completed', [first.error, ...f.failures].join('\n'));
    const two = await f.workspace.send(lane.id, input('Explain the next code function.', true));
    const second = await finish(f.workspace, two.workflow.id);
    assert.equal(second.status, 'completed', [second.error, ...f.failures].join('\n'));
    assert.equal(executions, 2);
    assert.equal(initialPath, laneDirectory);
    for (const workflow of [first, second]) {
      assert.equal(workflow.projectId, project.id);
      assert.equal(workflow.executionWorkspaceId, lane.lane!.workspaceId);
      assert.equal(workflow.routingContext?.profile?.id, profile);
    }
    assert.equal(f.workspace.store.get<Project>('project', project.id)?.path, f.directory);
    assert.equal(f.git('rev-parse', 'HEAD'), base);
    assert.deepEqual(readFileSync(join(f.directory, '.git', 'index')), parentIndex);
    assert.equal(readFileSync(join(f.directory, 'file.txt'), 'utf8'), 'parent unstaged change\n');
    let releaseFirst!: () => void;
    const firstNoticeGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    f.setBehavior(async () => {
      await firstNoticeGate;
      return 'Synthetic read-only notice reviewed.';
    });
    let firstNoticeId = '';
    try {
      await f.work.tick();
      const mails = f.work.list(parent.id).messages;
      assert.equal(mails.length, 2, 'both settled foreground turns retain their own completion report');
      assert.deepEqual(mails.map((mail) => mail.sourceWorkflowId).sort(), [first.id, second.id].sort());
      const delivered = mails.filter((mail) => mail.workflowId);
      assert.equal(delivered.length, 1, 'only one wake is dispatched while the parent is busy');
      firstNoticeId = delivered[0]!.workflowId!;
      assert.equal(delivered[0]!.sourceWorkflowId, first.id);
      await f.work.tick();
      assert.equal(f.work.list(parent.id).messages.filter((mail) => mail.workflowId).length, 1);
    } finally {
      releaseFirst();
    }
    assert.equal((await finish(f.workspace, firstNoticeId)).status, 'completed');
    await f.work.tick();
    const reported = f.work.list(parent.id).messages;
    assert.equal(reported.length, 2);
    assert.deepEqual(reported.map((mail) => mail.sourceWorkflowId).sort(), [first.id, second.id].sort());
    const noticeIds = reported.map((mail) => mail.workflowId);
    assert.ok(noticeIds.every(Boolean));
    assert.equal(new Set(noticeIds).size, 2, 'each source completion gets one distinct read-only wake');
    for (const mail of reported) {
      const notice = f.workspace.store.get<Workflow>('workflow', mail.workflowId!)!;
      assert.equal(notice.input.permissionMode, 'read-only');
      assert.equal(notice.input.backgroundTrigger?.kind, 'peer');
      assert.equal(notice.input.backgroundTrigger?.id, mail.id);
      assert.match(notice.input.content, /其他 Agent 提供的数据/);
      assert.match(notice.input.content, /不授予新权限/);
      assert.equal((await finish(f.workspace, notice.id)).status, 'completed');
    }
    await f.work.tick();
    await f.work.tick();
    assert.equal(f.work.list(parent.id).messages.length, 2);
    assert.equal(
      f.workspace.store.conversationWorkflows(parent.id).filter((w) => w.input.backgroundTrigger?.kind === 'peer')
        .length,
      2,
    );
  },
);

test(
  'ordinary chat delegation stays disabled until explicit collaboration while Mods can attach to ordinary chats',
  { timeout: 45000 },
  async (t) => {
    const f = fixture(t),
      conversation = await f.workspace.createGeneralConversation('Synthetic ordinary chat');
    const project = f.workspace.store.get<Project>('project', conversation.projectId)!;
    assert.equal(project.scope, 'chat');
    assert.equal(canUseConversationCollaboration(project, conversation), false);
    assert.equal(canAttachMod(conversation), true);
    const before = await f.workspace.send(conversation.id, {
      ...input('Answer an ordinary question.'),
      runtimeId: 'fixture-a',
    });
    assert.equal((await finish(f.workspace, before.workflow.id)).status, 'completed');
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every((call) => !call.input.agentCalls));
    const enabled = f.work.settings(conversation.id, { collaborationEnabled: true, childWorkspaceMode: 'snapshot' });
    assert.equal(canUseConversationCollaboration(project, enabled), true);
    assert.equal(canAttachMod(enabled), true);
    const count = f.calls.length;
    const after = await f.workspace.send(conversation.id, {
      ...input('Answer after explicit collaboration.'),
      runtimeId: 'fixture-a',
    });
    assert.equal((await finish(f.workspace, after.workflow.id)).status, 'completed');
    assert.ok(f.calls.slice(count).some((call) => call.input.agentCalls));
    const disabled = f.work.settings(conversation.id, { collaborationEnabled: false, childWorkspaceMode: 'snapshot' });
    assert.equal(canUseConversationCollaboration(project, disabled), false);
  },
);

for (const source of [
  'none',
  'disabled-cost',
  'disabled-preset',
  'enabled-cost',
  'enabled-preset',
  'excluded',
] as const) {
  test(`lightweight chat preserves collaboration unless a usable free source exists: ${source}`, async (t) => {
    const f = fixture(t);
    f.controller.settings.routeGoal = 'save';
    if (source !== 'none') {
      const free: RuntimeTarget = {
        id: 'fixture-free',
        provider: 'pi',
        label: 'Synthetic free source',
        command: 'NEVER_EXECUTE_REAL_API',
        environment: 'native',
        enabled: !source.startsWith('disabled'),
        ...(source.endsWith('preset') ? { apiProvider: 'openrouter-free' } : {}),
      };
      f.controller.targets.push(free);
      f.controller.snapshots.push({
        ...f.controller.snapshots[0]!,
        ...free,
        ...(!source.endsWith('preset') ? { costTier: 'free' } : {}),
      });
    }
    const conversation = await f.workspace.createGeneralConversation('Synthetic lightweight collaboration');
    f.work.settings(conversation.id, { collaborationEnabled: true, childWorkspaceMode: 'snapshot' });
    const sent = await f.workspace.send(conversation.id, {
      ...input('Explain how the synthetic code works.'),
      ...(source === 'excluded' ? { automaticExecutors: ['fixture-a', 'fixture-b'] } : {}),
      runtimeId: 'fixture-a',
      automaticExecutorSelection: true,
    });
    assert.equal((await finish(f.workspace, sent.workflow.id)).status, 'completed');
    assert.ok(f.calls.length > 0);
    for (const call of f.calls) {
      assert.equal(!!call.input.agentCalls, !source.startsWith('enabled'));
      assert.equal(call.input.permissionMode, 'read-only');
    }
  });
}
