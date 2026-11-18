import { idleMachineReading } from './helpers/machine-reading.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { Controller } from '../src/server/controller.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { Store } from '../src/server/store.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Explain the alternatives.',
  mode: 'auto',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-only',
  autoEscalate: true,
};

function fixture(t: TestContext, decisionMode: 'auto' | 'confirm' = 'auto') {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-manual-executor-')),
    dataDir = join(directory, 'data'),
    home = join(directory, 'empty-home');
  mkdirSync(home, { recursive: true });
  const environment: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    PATH: '',
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    GROK_HOME: join(home, 'grok'),
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
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
        absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('comborunner-manual-executor-'),
      );
      rmSync(absolute, { recursive: true, force: true });
    }
  });
  for (const [name, value] of Object.entries(environment))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  assert.equal(resolve(homedir()), resolve(home), 'fixtures must not inspect the real account homes');
  const targets: RuntimeTarget[] = ['grok-a', 'grok-b', 'codex-fixture'].map((id) => ({
    id,
    provider: id.startsWith('grok') ? 'grok' : 'codex',
    label: id,
    enabled: true,
    command: 'synthetic-only',
    commandDiscovery: 'fixed',
    environment: 'native',
    ...(id.startsWith('grok')
      ? { accountId: id, accountHome: join(home, id), accountFingerprint: `synthetic-${id}` }
      : {}),
  }));
  const seed = new Store(dataDir);
  seed.setConfig('targets', [
    ...targets,
    {
      id: 'pi-local',
      provider: 'pi',
      label: 'Disabled Pi',
      command: 'synthetic-only',
      environment: 'native',
      enabled: false,
    },
  ]);
  seed.close();
  const requests: unknown[] = [];
  const taskJudge = new TaskJudge({
    credential: () => 'synthetic-test-key',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const choice = (labels: string[], selected: string) => ({
        type: 'choice',
        choice: selected,
        confidence: 0.94,
        probabilities: Object.fromEntries(
          labels.map((label) => [label, label === selected ? 0.94 : 0.06 / (labels.length - 1)]),
        ),
      });
      return new Response(
        JSON.stringify({
          answers: {
            intent: choice(['question', 'action', 'uncertain'], 'question'),
            kind: choice(['routine', 'general', 'design', 'architecture'], 'design'),
            complexity: choice(['simple', 'standard', 'complex'], 'complex'),
          },
          usage: { input_tokens: 21, output_tokens: 9 },
        }),
      );
    },
  });
  controller = new Controller(directory, dataDir, {
    taskJudge,
    readAccountIdentity: (target) => target.accountFingerprint,
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  Object.assign(controller.settings, {
    taskJudgment: 'jev',
    decisionMode,
    designProvider: 'grok',
    routineProvider: 'codex',
    architectureProvider: 'codex',
  });
  // One clock reading for every card: per-card readings a millisecond apart decided ties by reset time.
  const observedAt = new Date().toISOString();
  const resetsAt = new Date(Date.parse(observedAt) + 3_600_000).toISOString();
  controller.snapshots = targets.map((target): RuntimeSnapshot => ({
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: target.environment,
    accountFingerprint: target.accountFingerprint,
    installed: true,
    status: 'ready',
    models: [
      {
        id: target.provider === 'grok' ? 'grok-4.7' : 'codex-full',
        label: 'Fixture full',
        efforts: ['low', 'medium', 'high', 'xhigh'],
      },
      {
        id: `${target.provider}-fixture-mini`,
        label: 'Fixture light',
        efforts: ['low', 'medium', 'high'],
        lightweight: true,
      },
    ],
    quota: {
      status: 'known',
      source: 'synthetic fixture',
      observedAt,
      windows: [{ id: 'week', label: 'Weekly', usedPercent: 10, resetsAt }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: observedAt,
  }));
  t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(controller, 'machineReading', idleMachineReading);
  const calls: ExecuteContext[] = [];
  const execute = async (context: ExecuteContext) => {
    calls.push(context);
    return { output: 'Synthetic task completed.', nativeSessionId: `synthetic-session-${calls.length}` };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(grokAdapter, 'execute', execute);
  workspace = new Workspace(controller, { autoTick: false, retryMs: 20, memoryDebounceMs: 20 });
  return { workspace, controller, calls, requests, targets };
}

async function settle(workspace: Workspace, id: string, statuses = ['completed', 'failed', 'blocked', 'cancelled']) {
  const active = (workspace as unknown as { active: Map<string, unknown> }).active;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    const terminal = ['completed', 'failed', 'blocked', 'cancelled'].includes(workflow.status);
    if (statuses.includes(workflow.status) && (!terminal || !active.has(id))) return workflow;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic workflow did not reach the expected state');
}

test('a pinned Grok B executes directly without Jev and preserves the exact model and effort', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...input,
    runtimeId: 'grok-b',
    model: 'grok-4.7',
    effort: 'xhigh',
  });
  const completed = await settle(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 0);
  assert.equal(controller.judgments.report().attemptedCalls, 0);
  assert.equal(completed.taskJudgment?.reason, 'manual-selection');
  assert.equal(completed.taskJudgment?.requestAttempted, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.target.id, 'grok-b');
  assert.equal(calls[0]!.route.model, 'grok-4.7');
  assert.equal(calls[0]!.route.effort, 'xhigh');
  // The file permission chosen in the composer applies to a pinned executor too.
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  // Jev was never asked, so the route explanation does not name it.
  assert.doesNotMatch(calls[0]!.route.reasons.join('\n'), /Jev/);
});

test('a selected executor can resolve automatic model and effort locally without remote screening', async (t) => {
  const { workspace, calls, requests } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, { ...input, runtimeId: 'grok-b' });
  const completed = await settle(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 0);
  assert.equal(calls[0]!.route.runtimeId, 'grok-b');
  assert.equal(calls[0]!.route.model, 'grok-4.7');
  assert.equal(calls[0]!.route.effort, 'medium');
});

test('a selected provider skips Jev while keeping account choice inside that provider', async (t) => {
  const { workspace, calls, requests } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, { ...input, provider: 'grok' });
  const completed = await settle(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 0);
  assert.equal(calls[0]!.target.provider, 'grok');
  assert.equal(completed.input.runtimeId, undefined);
});

test('fully automatic execution uses local routing despite obsolete Jev settings', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  controller.settings.routePreferencesEnabled = true;
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, input);
  const completed = await settle(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 0);
  assert.equal(controller.judgments.report().attemptedCalls, 0);
  assert.equal(completed.taskJudgment?.status, 'skipped');
  assert.equal(completed.taskJudgment?.source, 'local');
  assert.equal(completed.taskJudgment?.kind, undefined);
  assert.equal(calls[0]!.target.provider, 'codex');
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
});

test('a bounded lookup in automatic build mode uses one light execution without a planner or classifier', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  const conversation = await workspace.createGeneralConversation();
  const content = 'Find the security document in docs/ and list its path.';
  const execute = async (context: ExecuteContext) => {
    calls.push(context);
    return {
      output: context.input.stepId
        ? 'COMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Located docs/security.md","claims":[]}'
        : JSON.stringify({
            steps: Array.from({ length: 5 }, (_, index) => ({
              id: `lookup${index + 1}`,
              title: `Lookup ${index + 1}`,
              instruction: content,
              kind: 'general',
              dependsOn: index ? [`lookup${index}`] : [],
            })),
          }),
    };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(grokAdapter, 'execute', execute);
  const started = performance.now();
  const submitted = await workspace.send(conversation.id, {
    ...input,
    content: `Earlier context concerned security architecture.\n\nCurrent request: ${content}`,
    intentText: content,
    mode: 'build',
    permissionMode: 'read-only',
  });
  const completed = await settle(workspace, submitted.workflow.id);
  t.diagnostic(
    JSON.stringify({
      fixture: 'bounded-lookup',
      elapsedMs: Math.round(performance.now() - started),
      classifierCalls: requests.length,
      plannerCalls: calls.filter((call) => !call.input.stepId).length,
      executionCalls: calls.filter((call) => call.input.stepId).length,
      efforts: calls.map((call) => call.route.effort),
    }),
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.planning?.strategy, 'direct');
  assert.equal(completed.plan.length, 1);
  assert.equal(completed.taskJudgment?.reason, 'bounded-lookup');
  assert.equal(requests.length, 0);
  assert.equal(controller.judgments.report().attemptedCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.route.kind, 'routine');
  assert.equal(calls[0]!.route.model, 'codex-fixture-mini');
  assert.equal(calls[0]!.route.effort, 'low');
  assert.equal(calls[0]!.input.permissionMode, 'read-only');
  assert.equal(calls[0]!.input.routingPrompt, content);
  assert.equal(calls[0]!.input.stepId, completed.plan[0]!.id);
});

test('a fast lookup keeps explicit effort and still waits for configured route confirmation', async (t) => {
  const { workspace, calls, requests } = fixture(t, 'confirm');
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...input,
    content: 'Find the configuration file in docs/.',
    mode: 'build',
    permissionMode: 'read-only',
    effort: 'high',
  });
  const waiting = await settle(workspace, submitted.workflow.id, ['waiting-confirmation']);
  assert.equal(calls.length, 0);
  workspace.confirm(waiting.id, waiting.routingReview!.id);
  const completed = await settle(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.taskJudgment?.reason, 'confirmation-mode');
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.route.effort, 'high');
  assert.equal(calls[0]!.input.permissionMode, 'read-only');
});

test('manual executor selection keeps a write grant and scope note while direct replies disable the verifier', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  t.mock.method(controller, 'verify', async () => {
    throw new Error('The verifier must not run for read-only input');
  });
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...input,
    runtimeId: 'grok-b',
    content: 'Fix the typo teh to the in README.md. Do not edit any files.',
    verificationCommand: 'must-not-run',
  });
  const completed = await settle(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 0);
  assert.equal(completed.input.mode, 'chat');
  assert.equal(completed.input.permissionMode, 'workspace-write');
  assert.match(completed.input.scopeNote!, /Do not edit any files/);
  assert.equal(completed.input.verificationCommand, undefined);
  assert.ok(calls.every((call) => call.input.permissionMode === 'workspace-write' && !call.input.verificationCommand));
});

test('manual executor selection cannot bypass a readonly chip or a whole-message stop in auto mode', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  t.mock.method(controller, 'verify', async () => {
    throw new Error('The verifier must not run for read-only input');
  });
  for (const cap of [
    { content: 'Explain README.md.', permissionMode: 'read-only' as const },
    { content: '只看不改', explicitWrite: false },
  ]) {
    const conversation = await workspace.createGeneralConversation();
    const submitted = await workspace.send(conversation.id, {
      ...input,
      ...cap,
      runtimeId: 'grok-b',
      verificationCommand: 'must-not-run',
    });
    const completed = await settle(workspace, submitted.workflow.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.input.permissionMode, 'read-only');
    assert.equal(completed.input.verificationCommand, undefined);
    if (cap.explicitWrite === false) assert.equal(completed.input.readOnlyTrigger, '只看不改');
  }
  assert.equal(requests.length, 0);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((call) => call.input.permissionMode === 'read-only' && !call.input.verificationCommand));
});

test('manual executor selection still requires the configured suggest-confirm review', async (t) => {
  const { workspace, calls, requests } = fixture(t, 'confirm');
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, { ...input, runtimeId: 'grok-b', effort: 'high' });
  const waiting = await settle(workspace, submitted.workflow.id, ['waiting-confirmation']);
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(waiting.routingReview!.proposal.runtimeId, 'grok-b');
  workspace.confirm(waiting.id, waiting.routingReview!.id);
  const completed = await settle(workspace, waiting.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.taskJudgment?.reason, 'confirmation-mode');
  assert.equal(requests.length, 0);
  assert.equal(calls[0]!.route.runtimeId, 'grok-b');
  assert.equal(calls[0]!.route.effort, 'high');
});

test('an exhausted pinned account waits instead of silently starting another account or calling Jev', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  controller.snapshots.find((snapshot) => snapshot.id === 'grok-b')!.quota.windows[0]!.usedPercent = 100;
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...input,
    runtimeId: 'grok-b',
    allowExecutorFallback: false,
  });
  const waiting = await settle(workspace, submitted.workflow.id, ['waiting-resource']);
  assert.equal(waiting.input.runtimeId, 'grok-b');
  assert.equal(waiting.taskJudgment?.reason, 'manual-selection');
  assert.equal(calls.length, 0);
  assert.equal(requests.length, 0);
});

test('invalid model and unsupported effort remain explicit errors without any classifier or fallback executor', async (t) => {
  const { workspace, calls, requests } = fixture(t);
  for (const selection of [{ model: 'missing-model' }, { model: 'grok-4.7', effort: 'ultra' }]) {
    const conversation = await workspace.createGeneralConversation();
    const submitted = await workspace.send(conversation.id, {
      ...input,
      runtimeId: 'grok-b',
      ...selection,
      allowExecutorFallback: false,
    });
    const completed = await settle(workspace, submitted.workflow.id);
    assert.equal(completed.status, 'blocked');
    assert.match(completed.error!, selection.effort ? /不支持 ultra/ : /未发现指定模型/);
  }
  assert.equal(calls.length, 0);
  assert.equal(requests.length, 0);
});

test('verification escalation does not override an explicitly selected effort', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  let verifications = 0;
  t.mock.method(controller, 'verify', async () => {
    verifications++;
    return { command: 'synthetic-verifier', status: 'failed' as const, exitCode: 1, output: 'Synthetic failure' };
  });
  const conversation = await workspace.createGeneralConversation();
  const change = { kind: 'verification', projectId: conversation.projectId, command: 'synthetic-verifier' };
  const description = await desktopPermissionChange(workspace, change, false);
  await desktopPermissionChange(workspace, change, true, description);
  const submitted = await workspace.send(conversation.id, {
    ...input,
    runtimeId: 'grok-b',
    content: 'Format README.md',
    mode: 'build',
    effort: 'medium',
    verificationCommand: 'synthetic-verifier',
  });
  const failed = await settle(workspace, submitted.workflow.id);
  assert.equal(failed.status, 'blocked');
  assert.equal(verifications, 1);
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.route.runtimeId, 'grok-b');
  assert.equal(calls[0]!.route.effort, 'medium');
});

test('an unapproved verifier is skipped without overriding an explicitly selected effort', async (t) => {
  const { workspace, controller, calls, requests } = fixture(t);
  const verify = t.mock.method(controller, 'verify', async () => {
    throw new Error('An unapproved verifier must not run');
  });
  const conversation = await workspace.createGeneralConversation();
  const submitted = await workspace.send(conversation.id, {
    ...input,
    runtimeId: 'grok-b',
    content: 'Format README.md',
    mode: 'build',
    effort: 'medium',
    verificationCommand: 'synthetic-verifier',
  });
  const completed = await settle(workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(verify.mock.callCount(), 0);
  const run = controller.store.run(completed.runIds.at(-1)!)!;
  assert.equal(run.verification?.command, 'synthetic-verifier');
  assert.equal(run.verification?.status, 'skipped');
  assert.equal(run.verification?.output, '验收命令未经桌面批准，已跳过');
  assert.ok(run.events.some((event) => event.text === '验收命令未经桌面批准，已跳过'));
  assert.equal(requests.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.route.runtimeId, 'grok-b');
  assert.equal(calls[0]!.route.effort, 'medium');
});

test('the controller applies a technical-failure cooldown before automatic routing', (t) => {
  const { controller, targets } = fixture(t);
  const codex = targets.find((target) => target.id === 'codex-fixture')!;
  const request = {
    prompt: 'Explain the alternatives.',
    projectPath: controller.settings.defaultProjectPath,
    kind: 'routine' as const,
  };
  assert.equal(controller.preview(request).runtimeId, codex.id);
  controller.cooldown.failure(codex, {
    id: 'failed-run',
    status: 'failed',
    errorCode: 'runtime-process-closed',
    startedAt: new Date().toISOString(),
    route: { runtimeId: codex.id },
  } as never);
  const decision = controller.preview(request);
  assert.notEqual(decision.runtimeId, codex.id);
  assert.equal(controller.preview({ ...request, runtimeId: codex.id }).runtimeId, codex.id);
});
