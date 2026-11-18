import { settledWorkflow as finish, workflowState } from './helpers/workflow-state.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller, removedMagpieMessage } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { canContinueWorkflow } from '../src/ui/queue-utils.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Fix the typo in README.md',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  autoEscalate: false,
};

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'workflow-resume-test-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.targets = (['codex', 'claude'] as const).map((provider) => ({
    id: provider,
    provider,
    label: provider,
    command: 'unused',
    environment: 'native',
    enabled: true,
  }));
  const snapshot = (target: RuntimeTarget): RuntimeSnapshot => ({
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
  });
  controller.snapshots = controller.targets.map(snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  const options = { hold: false };
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => controller.broadcast());
    if (options.hold)
      await new Promise((_resolve, reject) =>
        ctx.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
      );
    if (ctx.input.stepId && ctx.input.permissionMode === 'workspace-write') {
      writeFileSync(join(ctx.input.projectPath, 'README.md'), `Fixed the typo. Revision ${calls.length}.\n`);
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          itemId: `edit-${calls.length}`,
          kind: 'fileChange',
          status: 'completed',
          input: { changes: [{ path: 'README.md', kind: { type: 'update' } }] },
        },
      });
    }
    return { output: `output of call ${calls.length}`, nativeSessionId: `session-${ctx.target.id}` };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(absolute).startsWith('workflow-resume-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  return { workspace, controller, calls, options };
}

/** Rewrites a finished workflow as if the user had stopped it mid-way. */
function markStopped(workspace: Workspace, workflow: Workflow, patch: Partial<Workflow> = {}) {
  const stopped: Workflow = { ...workflow, status: 'cancelled', stopped: true, ...patch };
  workspace.store.save('workflow', stopped.id, stopped.conversationId, stopped);
  return stopped;
}

test('a stopped task continues on the same executor, model and effort and reuses its native session', async (t) => {
  const { workspace, controller, calls } = fixture(t);
  controller.settings.routePreferencesEnabled = true;
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  const done = await finish(workspace, submitted.workflow.id);
  assert.equal(done.status, 'completed', done.error ?? 'file receipts should confirm the task');
  const firstRun = controller.run(done.runIds.at(-1)!)!;
  assert.equal(firstRun.route.runtimeId, 'codex');
  const stopped = markStopped(workspace, done);
  assert.equal(canContinueWorkflow(stopped), true);

  // Routing preferences changed since; a resumed task must still stay on the session that holds its context.
  controller.settings.architectureProvider = 'claude';
  controller.settings.routineProvider = 'claude';
  controller.settings.designProvider = 'claude';
  const continued = await workspace.continue(stopped.id);
  assert.equal(continued.workflow.input.runtimeId, 'codex');
  assert.equal(continued.workflow.input.model, firstRun.route.model);
  assert.equal(continued.workflow.input.effort, firstRun.route.effort);
  assert.equal((await finish(workspace, continued.workflow.id)).status, 'completed');
  assert.equal(calls.at(-1)!.target.id, 'codex');
  assert.equal(calls.at(-1)!.input.continuationRunId, firstRun.id);
});

test('a stopped task falls back to normal scheduling when its executor is unavailable', async (t) => {
  const { workspace, controller } = fixture(t);
  controller.settings.routePreferencesEnabled = true;
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  const stopped = markStopped(workspace, await finish(workspace, submitted.workflow.id));
  controller.targets = controller.targets.map((target) =>
    target.id === 'codex' ? { ...target, enabled: false } : target,
  );
  const continued = await workspace.continue(stopped.id);
  assert.equal(continued.workflow.input.runtimeId, undefined);
});

test('a retired gateway task requires an explicit replacement and drops only the obsolete routing pins', async (t) => {
  const { workspace, controller, calls } = fixture(t);
  const legacy: RuntimeTarget = {
    id: 'renamed-legacy-gateway',
    provider: 'pi',
    gateway: 'magpie',
    label: 'Legacy gateway',
    command: 'never-spawn',
    environment: 'native',
    enabled: false,
  };
  controller.targets.push(legacy);
  for (const [runtimeId, pinned, replacement] of [
    ['pi-magpie', false, { runtimeId: 'claude' }],
    [legacy.id, true, { provider: 'codex' as const }],
  ] as const) {
    const conversation = await workspace.createGeneralConversation();
    const submitted = await workspace.send(conversation.id, input);
    const done = await finish(workspace, submitted.workflow.id);
    const run = controller.run(done.runIds.at(-1)!)!;
    run.route = { ...run.route, runtimeId, model: 'magpie/group/old-model', effort: 'max' };
    controller.store.saveRun(run);
    const stopped = markStopped(workspace, done, {
      ...(pinned
        ? {
            plan: [
              { ...done.plan[0]!, status: 'completed' as const },
              { ...done.plan[0]!, id: 'remaining', status: 'failed' as const, transport: 'api' as const, runIds: [] },
            ],
          }
        : {}),
      input: {
        ...done.input,
        ...(pinned ? { runtimeId, provider: 'pi', model: run.route.model, effort: 'max' } : {}),
        executionPolicy: 'api-only',
      },
    });
    const before = calls.length;
    await assert.rejects(workspace.continue(stopped.id), { message: removedMagpieMessage });
    assert.equal(calls.length, before);
    assert.equal(workspace.store.get<Workflow>('workflow', stopped.id)?.followUp, undefined);
    const continued = await workspace.continue(stopped.id, undefined, replacement);
    assert.equal(continued.workflow.input.model, undefined);
    assert.equal(continued.workflow.input.effort, undefined);
    assert.equal(continued.workflow.input.permissionMode, stopped.input.permissionMode);
    assert.equal(continued.workflow.input.executionPolicy, 'cli-first');
    if (pinned) assert.equal(continued.workflow.plan[0]?.transport, 'auto');
    assert.equal((await finish(workspace, continued.workflow.id)).status, 'completed');
    assert.equal(calls.at(-1)!.target.id, 'runtimeId' in replacement ? replacement.runtimeId : replacement.provider);
    assert.equal(calls.at(-1)!.route.model, 'test-model');
    assert.equal(controller.run(run.id)?.route.model, 'magpie/group/old-model');
  }
});

test('stopping a running task keeps it resumable', async (t) => {
  const { workspace, calls, options } = fixture(t);
  options.hold = true;
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  void workspace.tickQueue();
  await workflowState(workspace, () => calls.length > 0);
  workspace.cancel(submitted.workflow.id);
  const stopped = await finish(workspace, submitted.workflow.id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.stopped, true);
  assert.equal(canContinueWorkflow(stopped), true);
  options.hold = false;
  const continued = await workspace.continue(stopped.id);
  assert.equal((await finish(workspace, continued.workflow.id)).status, 'completed');
});

test('a task cancelled before it started cannot be continued', async (t) => {
  const { workspace } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  workspace.cancel(submitted.workflow.id);
  const cancelled = workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(canContinueWorkflow(cancelled), false);
  await assert.rejects(workspace.continue(cancelled.id), /已取消/);
});

test('an interrupted multi-step plan resumes at the first unfinished step without re-planning', async (t) => {
  const { workspace, calls } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  const done = await finish(workspace, submitted.workflow.id);
  const step = (id: string, status: Workflow['plan'][number]['status'], dependsOn: string[] = []) => ({
    id,
    title: `Step ${id}`,
    instruction: `Do ${id}`,
    kind: 'general' as const,
    transport: 'auto' as const,
    dependsOn,
    status,
    runIds: status === 'completed' ? [done.runIds.at(-1)!] : [],
  });
  const stopped = markStopped(workspace, done, {
    status: 'interrupted',
    plan: [step('a', 'completed'), step('b', 'failed', ['a']), step('c', 'pending', ['b'])],
  });
  const before = calls.length;
  const continued = await workspace.continue(stopped.id);
  assert.equal(continued.workflow.planning?.strategy, 'resume');
  assert.deepEqual(
    continued.workflow.plan.map((s) => [s.id, s.status, s.dependsOn]),
    [
      ['b', 'pending', []],
      ['c', 'pending', ['b']],
    ],
  );
  const resumed = await finish(workspace, continued.workflow.id);
  assert.equal(resumed.status, 'completed');
  // Exactly the two remaining steps ran; no planner call and the finished step was not repeated.
  assert.equal(calls.length - before, 2);
  const prompt = (ctx: ExecuteContext) => ctx.input.continuationPrompt ?? ctx.input.prompt;
  assert.match(prompt(calls[before]!), /Step a（已在中断前完成）/);
  assert.match(prompt(calls[before]!), /Do b/);
  assert.match(prompt(calls[before + 1]!), /Do c/);
});
