import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

const baseInput: MessageInput = {
  content: 'Could you assess the two alternatives?',
  mode: 'auto',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
};
function observed(target: RuntimeTarget): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: target.environment,
    installed: true,
    status: 'ready',
    models: [
      {
        id: `${target.provider}-fixture-mini`,
        label: 'Fixture light',
        efforts: ['low', 'medium', 'high'],
        lightweight: true,
      },
      { id: `${target.provider}-fixture-full`, label: 'Fixture full', efforts: ['low', 'medium', 'high'] },
    ],
    quota: {
      status: 'known',
      source: 'synthetic fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
}
function fixture(t: TestContext, options: { mode?: 'auto' | 'confirm' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-judgment-workflow-')),
    dataDir = join(directory, 'data'),
    home = join(directory, 'empty-home');
  mkdirSync(home, { recursive: true });
  const overrides: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    PATH: '',
    JEV_API_KEY: 'synthetic-old-jev-key',
    TYPESAFE_API_KEY: 'synthetic-old-typesafe-key',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  let controller: Controller | undefined, workspace: Workspace | undefined;
  t.after(async () => {
    try {
      await workspace?.close();
      await controller?.close();
    } finally {
      for (const [name, value] of Object.entries(previous))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      const absolute = resolve(directory);
      assert.ok(
        absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('comborunner-judgment-workflow-'),
      );
      rmSync(absolute, { recursive: true, force: true });
    }
  });
  for (const [name, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  assert.equal(resolve(homedir()), resolve(home), 'controller diagnostics must not inspect real local credentials');
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('External HTTP is forbidden');
  });
  const requests: Array<{ state: { request: string }; model: string }> = [];
  const judge = new TaskJudge({
    credential: () => 'synthetic-test-key',
    fetch: async (url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      throw new Error('Retired classifier transport must never run');
    },
  });
  const targets: RuntimeTarget[] = (['codex', 'claude'] as const).map((provider) => ({
    id: provider,
    provider,
    label: provider,
    command: 'fixture-only',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
  }));
  const stored = new Store(dataDir);
  stored.setConfig('targets', [
    ...targets,
    {
      id: 'pi-local',
      provider: 'pi',
      label: 'Disabled local Pi',
      command: 'fixture-only',
      environment: 'native',
      enabled: false,
    },
  ]);
  stored.close();
  controller = new Controller(directory, dataDir, { taskJudge: judge });
  clearInterval(controller.timer);
  Object.assign(controller.settings, {
    decisionMode: options.mode ?? 'auto',
    taskJudgment: 'jev',
    memoryEvidence: 'jev',
    routePreferencesEnabled: true,
    architectureProvider: 'codex',
    routineProvider: 'codex',
    designProvider: 'claude',
  });
  controller.snapshots = targets.map(observed);
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    ctx.emit({
      type: 'usage',
      at: new Date().toISOString(),
      data: { inputTokens: 70, outputTokens: 30, totalTokens: 100, eventId: 'fixture-round' },
    });
    return {
      output: ctx.input.stepId
        ? 'Synthetic step completed'
        : JSON.stringify({
            steps: [
              {
                id: 'first',
                title: 'First bounded step',
                instruction: 'Complete the requested first portion',
                kind: 'general',
                transport: 'cli',
                dependsOn: [],
              },
              {
                id: 'second',
                title: 'Second bounded step',
                instruction: 'Complete the requested remaining portion',
                kind: 'general',
                transport: 'cli',
                dependsOn: ['first'],
              },
            ],
          }),
      nativeSessionId: `fixture-session-${calls.length}`,
    };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  t.mock.method(piAdapter, 'execute', execute);
  workspace = new Workspace(controller, { autoTick: false, retryMs: 1 });
  return { directory, controller, workspace, requests, calls };
}
async function finish(workspace: Workspace, id: string): Promise<Workflow> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Synthetic workflow did not settle');
}

test('legacy enabled settings and synthetic keys cannot classify a task remotely', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  workspace.updateMemory(conversation.projectId, 'PRIVATE_MEMORY_MUST_NOT_ENTER_CLASSIFIER', 0);
  const submitted = await workspace.send(conversation.id, baseInput);
  const completed = await finish(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed', completed.error ?? 'Synthetic workflow should complete');
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(completed.taskJudgment?.source, 'local');
  assert.equal(completed.taskJudgment?.requestAttempted, false);
  assert.equal(completed.input.mode, 'chat');
  assert.equal(calls[0]!.target.environment, 'native');
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  assert.equal(controller.judgments.report().attemptedCalls, 0);
});

test('confirmation mode makes no judgment call before or after approval and keeps the exact reviewed native route', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t, { mode: 'confirm' });
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...baseInput,
    content: 'Create a document and a companion summary.',
  });
  await workspace.tickQueue();
  const pending = workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(pending.status, 'waiting-confirmation');
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(controller.judgments.report().attemptedCalls, 0);
  const reviewed = structuredClone(pending.routingReview!.proposal);
  workspace.confirm(pending.id, pending.routingReview!.id);
  controller.settings.architectureProvider = 'claude';
  const completed = await finish(workspace, pending.id);
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(completed.taskJudgment?.reason, 'confirmation-mode');
  assert.equal(completed.taskJudgment?.requestAttempted, false);
  for (const call of calls) {
    assert.equal(call.route.runtimeId, reviewed.runtimeId);
    assert.equal(call.route.model, reviewed.model);
    assert.equal(call.route.effort, reviewed.effort);
  }
});

test('manual runtime, model and effort survive obsolete enabled settings', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...baseInput,
    mode: 'chat',
    runtimeId: 'codex',
    model: 'codex-fixture-full',
    effort: 'high',
    permissionMode: 'read-only',
  });
  const completed = await finish(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed', completed.error ?? 'Synthetic workflow should complete');
  assert.equal(requests.length, 0);
  assert.equal(completed.taskJudgment?.reason, 'manual-selection');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.route.runtimeId, 'codex');
  assert.equal(calls[0]!.route.model, 'codex-fixture-full');
  assert.equal(calls[0]!.route.effort, 'high');
  assert.equal(calls[0]!.input.permissionMode, 'read-only');
  assert.equal(controller.judgments.report().attemptedCalls, 0);
});

test('a prelaunch resource wait reuses local judgment without invoking the retired classifier', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  const start = controller.start.bind(controller);
  let starts = 0;
  t.mock.method(controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (++starts === 1) throw new RouteUnavailableError('capacity', ['synthetic temporary contention']);
    return start(...args);
  });
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, baseInput);
  const completed = await finish(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed', completed.error ?? 'Synthetic workflow should complete');
  assert.equal(starts, 2);
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(controller.judgments.report().attemptedCalls, 0);
});
