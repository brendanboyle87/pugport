import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import { createGrokAdapter, grokAdapter } from '../src/server/adapters/grok.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import type {
  ExecuteContext,
  MessageInput,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

const message: MessageInput = {
  content: 'Explain the difference between these alternatives.',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
  allowUnknownQuota: true,
};
type Script = { packets: unknown[]; exitCode?: number };
type Options = {
  mode?: 'auto' | 'confirm';
  fingerprints?: string[];
  script?: (context: ExecuteContext, index: number) => Script;
  before?: (context: ExecuteContext, index: number) => Promise<void> | void;
};
const quota = (): Script => ({
  exitCode: 1,
  packets: [
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Rate limit exceeded',
      errors: ['Rate limit exceeded'],
      usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
    },
  ],
});
const authentication = (): Script => ({
  exitCode: 1,
  packets: [
    { type: 'error', error: { type: 'authentication_error', message: 'Authentication required', status: 401 } },
  ],
});
const success = (result = 'Synthetic response from the second account'): Script => ({
  packets: [
    { type: 'result', subtype: 'success', result, usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 } },
  ],
});
function observed(target: RuntimeTarget): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: target.environment,
    accountFingerprint: target.accountFingerprint,
    installed: true,
    status: 'ready',
    models: [{ id: 'grok-4.7', label: 'Synthetic model catalog', efforts: ['low', 'medium', 'high', 'xhigh'] }],
    quota: { status: 'unknown', source: 'Synthetic account observation', observedAt: null, windows: [] },
    accounting: { mode: 'unknown', source: 'Synthetic subscription account; no remaining balance is invented' },
    capabilities: { execute: true, resume: true, cancel: true, approvals: false },
    refreshedAt: new Date().toISOString(),
  };
}
function fixture(t: TestContext, options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-account-relay-')),
    dataDir = join(directory, 'data'),
    home = join(directory, 'empty-home');
  mkdirSync(home, { recursive: true });
  const overrides: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    PATH: '',
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
    GROK_HOME: join(home, 'grok'),
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  let controller: Controller, workspace: Workspace;
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
        absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('comborunner-account-relay-'),
      );
      rmSync(absolute, { recursive: true, force: true });
    }
  });
  for (const [name, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  assert.equal(resolve(homedir()), resolve(home), 'constructor and ledger imports must not inspect the real user home');
  const targets: RuntimeTarget[] = (options.fingerprints ?? ['synthetic-account-a', 'synthetic-account-b']).map(
    (hash, index) => ({
      id: `grok-${String.fromCharCode(97 + index)}`,
      provider: 'grok',
      label: `Synthetic account ${index + 1}`,
      command: 'fixture-only',
      commandDiscovery: 'fixed',
      environment: 'native',
      enabled: true,
      accountId: `synthetic-profile-${index + 1}`,
      accountHome: join(dataDir, 'accounts', `synthetic-${index + 1}`),
      accountFingerprint: hash,
    }),
  );
  const identities = new Map<string, string | undefined>(
    targets.map((target) => [target.id, target.accountFingerprint]),
  );
  const seed = new Store(dataDir);
  seed.setConfig('targets', [
    ...targets,
    {
      id: 'pi-local',
      provider: 'pi',
      label: 'Disabled Pi',
      command: 'fixture-only',
      commandDiscovery: 'fixed',
      environment: 'native',
      enabled: false,
    },
  ]);
  seed.close();
  const calls: ExecuteContext[] = [],
    argv: string[][] = [];
  t.mock.method(grokAdapter, 'execute', async (context: ExecuteContext) => {
    const index = calls.push(context) - 1;
    await options.before?.(context, index);
    const script = options.script?.(context, index) ?? (context.target.id === 'grok-a' ? quota() : success());
    // Exercise the legacy Messages parser, arguments and account safety here.
    // ACP steering is covered by grok-steer.test.ts. Only the process boundary
    // is replaced; no CLI, credential lookup or network runs.
    const adapter = createGrokAdapter({
      targetPath: async (_target, path) => path,
      spawn: async (_target, args) => {
        argv.push(args);
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null as number | null,
          signalCode: null,
        }) as unknown as ChildProcessWithoutNullStreams;
        child.stdin.on('finish', () => {
          for (const packet of script.packets) (child.stdout as PassThrough).write(`${JSON.stringify(packet)}\n`);
          child.emit('close', script.exitCode ?? 0);
        });
        return child;
      },
      terminate: async () => {},
    });
    return adapter.execute({ ...context, registerSteer: undefined });
  });
  const open = () => {
    controller = new Controller(directory, dataDir, {
      readAccountIdentity: (target) => identities.get(target.id),
      taskJudge: new TaskJudge({
        credential: () => undefined,
        fetch: async () => {
          throw new Error('No network is permitted in account relay fixtures');
        },
      }),
    });
    clearInterval(controller.timer);
    Object.assign(controller.settings, {
      decisionMode: options.mode ?? 'auto',
      taskJudgment: 'local',
      architectureProvider: 'grok',
      routineProvider: 'grok',
      designProvider: 'grok',
      unknownQuotaPolicy: 'allow',
    });
    controller.snapshots = targets.map(observed);
    t.mock.method(controller, 'refresh', async () => {});
    workspace = new Workspace(controller, { autoTick: false, retryMs: 20 });
  };
  open();
  return {
    directory,
    dataDir,
    targets,
    identities,
    calls,
    argv,
    get controller() {
      return controller;
    },
    get workspace() {
      return workspace;
    },
    async restart() {
      await workspace.close();
      await controller.close();
      open();
    },
  };
}
// Waits poll for the expected state; the deadline only ends a genuine hang. Discovery, mock CLI turns and
// persistence can take several seconds on a busy CI runner, so no happy path should have to beat it.
async function until(predicate: () => boolean, tick?: () => Promise<unknown>, timeoutMs = 30_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await tick?.();
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(
    predicate(),
    true,
    `the synthetic workflow should reach the expected state within ${timeoutMs} ms (elapsed ${Date.now() - startedAt} ms)`,
  );
}
async function finish(workspace: Workspace, id: string): Promise<Workflow> {
  await until(
    () =>
      ['completed', 'blocked', 'cancelled', 'failed'].includes(workspace.store.get<Workflow>('workflow', id)!.status),
    () => workspace.tickQueue(),
  );
  return workspace.store.get<Workflow>('workflow', id)!;
}
async function submit(workspace: Workspace, input: MessageInput = message) {
  const conversation = await workspace.createGeneralConversation();
  return workspace.send(conversation.id, input);
}
const runs = (controller: Controller, workflow: Workflow) => workflow.runIds.map((id) => controller.store.run(id)!);
async function settleRun(controller: Controller, run: RunRecord) {
  await until(() => !controller.active.has(run.id));
  return controller.store.run(run.id)!;
}

test('native Grok quota result relays once with the same model and effort, a fresh session, and separate per-account usage', async (t) => {
  const f = fixture(t),
    submitted = await submit(f.workspace, { ...message, model: 'grok-4.7', effort: 'high' });
  const completed = await finish(f.workspace, submitted.workflow.id),
    [first, second] = runs(f.controller, completed);
  assert.equal(completed.status, 'completed');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['grok-a', 'grok-b'],
  );
  assert.ok(f.calls.every((call) => call.route.model === 'grok-4.7' && call.route.effort === 'high'));
  assert.equal(first!.error, 'quota-or-rate-limit');
  assert.equal(first!.output, '', 'error descriptions are not assistant output');
  assert.equal(second!.status, 'completed');
  assert.equal(second!.parentRunId, undefined);
  assert.deepEqual(second!.relay, { fromRunId: first!.id, fromRuntimeId: 'grok-a', reason: 'quota' });
  assert.equal(first!.account?.id, f.targets[0]!.accountId);
  assert.equal(second!.account?.id, f.targets[1]!.accountId);
  assert.notEqual(first!.nativeSessionId, second!.nativeSessionId);
  assert.ok(f.argv.every((args) => args.includes('--session-id') && !args.includes('--resume')));
  assert.ok(f.calls.every((call) => call.input.permissionMode === 'read-only' && call.nativeSessionId === undefined));
  const usage = f.controller.usage.report();
  assert.equal(usage.totals.totalTokens, 14);
  assert.equal(usage.perRun.length, 2);
  assert.equal(usage.byRuntime.find((row) => row.runtimeId === 'grok-a')?.totalTokens, 3);
  assert.equal(usage.byRuntime.find((row) => row.runtimeId === 'grok-b')?.totalTokens, 11);
  assert.equal(usage.totals.estimatedCostUsd, null, 'missing cost is not an invented zero');
  assert.equal(f.controller.accountHealth.report().length, 1);
});

test('when both accounts hit quota, the workflow waits for cooldown without a tight retry loop and remains cancellable', async (t) => {
  const f = fixture(t, { script: () => quota() }),
    submitted = await submit(f.workspace);
  await until(
    () => f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)?.status === 'waiting-resource',
    () => f.workspace.tickQueue(),
  );
  const waiting = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(f.calls.length, 2);
  assert.equal(waiting.runIds.length, 2);
  assert.ok(Date.parse(waiting.scheduling?.nextAttemptAt ?? '') > Date.now() + 30_000);
  for (let i = 0; i < 20; i++) await f.workspace.tickQueue();
  assert.equal(f.calls.length, 2);
  assert.equal(f.controller.active.size, 0);
  f.workspace.cancel(waiting.id);
  const cancelled = await finish(f.workspace, waiting.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(f.calls.length, 2);
  assert.equal(f.controller.accountHealth.report().length, 2);
});

test('a structured authentication error switches accounts and latches the failed identity until an explicit successful check', async (t) => {
  const f = fixture(t, { script: (context) => (context.target.id === 'grok-a' ? authentication() : success()) });
  const submitted = await submit(f.workspace),
    completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['grok-a', 'grok-b'],
  );
  const [first, second] = runs(f.controller, completed);
  assert.equal(first!.error, 'authentication-required');
  assert.equal(second!.relay?.reason, 'authentication');
  const health = f.controller.accountHealth.report();
  assert.equal(health[0]?.reason, 'authentication');
  assert.equal(health[0]?.retryAt, undefined);
  assert.equal(f.controller.accountHealth.apply(observed(f.targets[0]!)).availability?.reason, 'authentication');
});

test('cooldown survives controller restart even if one account observation omits its fingerprint', async (t) => {
  const f = fixture(t),
    submitted = await submit(f.workspace);
  assert.equal((await finish(f.workspace, submitted.workflow.id)).status, 'completed');
  const original = f.controller.accountHealth.report()[0]!;
  await f.restart();
  assert.deepEqual(f.controller.accountHealth.report()[0], original);
  const first = f.controller.snapshots.find((row) => row.id === 'grok-a')!;
  delete first.accountFingerprint;
  const input = {
    prompt: message.content,
    projectPath: f.directory,
    kind: 'general' as const,
    executionPolicy: 'cli-only' as const,
    allowUnknownQuota: true,
  };
  assert.equal(f.controller.accountHealth.apply(first).availability?.retryAt, original.retryAt);
  assert.equal(f.controller.preview(input).runtimeId, 'grok-b');
  assert.throws(
    () => f.controller.preview({ ...input, runtimeId: 'grok-a' }),
    (error: unknown) =>
      error instanceof RouteUnavailableError &&
      (error.kind === 'refresh' || (error.kind === 'quota' && error.retryAt === original.retryAt)),
  );
  const next = await submit(f.workspace),
    completed = await finish(f.workspace, next.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['grok-a', 'grok-b', 'grok-b'],
  );
});

test('an explicit runtime pin never silently changes accounts after quota', async (t) => {
  const f = fixture(t),
    submitted = await submit(f.workspace, {
      ...message,
      runtimeId: 'grok-a',
      autoEscalate: true,
      allowExecutorFallback: false,
    });
  const completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.target.id, 'grok-a');
  assert.equal(runs(f.controller, completed)[0]!.relay, undefined);
});

test('confirmation mode keeps the reviewed account/model/effort when quota fails after approval', async (t) => {
  const f = fixture(t, { mode: 'confirm' }),
    submitted = await submit(f.workspace, { ...message, autoEscalate: true, allowExecutorFallback: false });
  await f.workspace.tickQueue();
  const pending = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(pending.status, 'waiting-confirmation');
  assert.equal(f.calls.length, 0);
  const reviewed = structuredClone(pending.routingReview!.proposal);
  f.workspace.confirm(pending.id, pending.routingReview!.id);
  const completed = await finish(f.workspace, pending.id);
  assert.equal(completed.status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    { runtimeId: f.calls[0]!.route.runtimeId, model: f.calls[0]!.route.model, effort: f.calls[0]!.route.effort },
    { runtimeId: reviewed.runtimeId, model: reviewed.model, effort: reviewed.effort },
  );
});

test('a native read-only text answer can hand off after quota without replaying file operations', async (t) => {
  const f = fixture(t, {
    script: (context) =>
      context.target.id !== 'grok-a'
        ? success('Continued answer')
        : {
            ...quota(),
            packets: [
              {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: 'Already started the answer.' },
                },
              },
              ...quota().packets,
            ],
          },
  });
  const submitted = await submit(f.workspace, { ...message, autoEscalate: true }),
    completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(f.calls.length, 2);
  assert.equal(runs(f.controller, completed)[0]!.output, 'Already started the answer.');
  assert.equal(runs(f.controller, completed)[0]!.handoffCheckpoint?.safe, true);
  assert.match(f.calls[1]!.input.prompt, /Already started the answer/);
  assert.equal(f.calls[1]!.input.permissionMode, 'read-only');
});

test('writable partial text without a native tool checkpoint cannot hand off after quota', async (t) => {
  const f = fixture(t, {
    script: (context) =>
      context.input.stepId
        ? quota()
        : success(
            JSON.stringify({
              steps: [
                {
                  id: 'document',
                  title: 'Write the requested document',
                  instruction: 'Create the document from the supplied requirements',
                  kind: 'general',
                  transport: 'cli',
                  dependsOn: [],
                },
              ],
            }),
          ),
    before: (context) => {
      if (context.input.stepId) {
        assert.equal(context.input.permissionMode, 'workspace-write');
        context.emit({ at: new Date().toISOString(), type: 'text', text: 'I changed some files.' });
      }
    },
  });
  const submitted = await submit(f.workspace, {
    ...message,
    mode: 'build',
    content: 'Create a document and a companion summary.',
    permissionMode: 'workspace-write',
  });
  const completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'blocked');
  assert.equal(f.calls.filter((call) => call.input.stepId).length, 1);
  assert.equal(
    runs(f.controller, completed).find((run) => run.stepId === 'document')?.handoffCheckpoint?.blockedReason,
    'missing-checkpoint',
  );
});

test('a tool call remains a replay barrier after the full ledger restores the rolling-buffer event', async (t) => {
  const f = fixture(t, {
    before: (context) => {
      context.emit({ type: 'tool', at: new Date().toISOString(), text: 'Synthetic completed write' });
      for (let i = 0; i < 1005; i++)
        context.emit({ type: 'status', at: new Date().toISOString(), text: 'Synthetic later status' });
    },
  });
  const submitted = await submit(f.workspace, { ...message, autoEscalate: true }),
    completed = await finish(f.workspace, submitted.workflow.id);
  const run = runs(f.controller, completed)[0]!;
  assert.equal(completed.status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.equal(run.hadToolActivity, true);
  assert.equal(
    run.events.some((event) => event.type === 'tool'),
    true,
  );
});

test('an approval requested through the controller is a sticky replay barrier even without an adapter approval event', async (t) => {
  const f = fixture(t, {
    before: async (context) => {
      await context.approve('SyntheticTool', 'Synthetic approval; no real external action.');
    },
  });
  f.controller.updateSettings({ toolApprovalMode: 'ask' });
  const submitted = await submit(f.workspace, { ...message, autoEscalate: true });
  await until(
    () => f.controller.approvals.size === 1,
    () => f.workspace.tickQueue(),
  );
  const approval = [...f.controller.approvals.keys()][0]!;
  f.controller.answerApproval(approval, true);
  const completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.equal(runs(f.controller, completed)[0]!.hadToolActivity, true);
});

test('two profiles of the same authenticated account are not counted as fresh capacity', async (t) => {
  const f = fixture(t, { fingerprints: ['same-identity', 'same-identity'] });
  const submitted = await submit(f.workspace);
  await until(
    () => f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)?.status === 'waiting-resource',
    () => f.workspace.tickQueue(),
  );
  const waiting = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(waiting.status, 'waiting-resource');
  assert.equal(f.calls.length, 1);
  assert.equal(waiting.runIds.length, 1);
  assert.equal(runs(f.controller, waiting)[0]?.handoffCheckpoint?.safe, true);
  assert.equal(f.controller.accountHealth.apply(observed(f.targets[1]!)).availability?.reason, 'quota');
  for (let index = 0; index < 10; index++) await f.workspace.tickQueue();
  assert.equal(f.calls.length, 1, 'an alias cannot replay the same exhausted identity');
  f.workspace.cancel(waiting.id);
  assert.equal((await finish(f.workspace, waiting.id)).status, 'cancelled');
});

test('relay skips duplicate profiles and selects a genuinely different account', async (t) => {
  const f = fixture(t, { fingerprints: ['same-identity', 'same-identity', 'distinct-identity'] });
  const submitted = await submit(f.workspace),
    completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['grok-a', 'grok-c'],
  );
  assert.equal(runs(f.controller, completed)[1]!.relay?.fromRuntimeId, 'grok-a');
});

test('a planner quota failure can relay before executing the planned steps', async (t) => {
  const f = fixture(t, {
    script: (context) =>
      context.target.id === 'grok-a'
        ? quota()
        : !context.input.stepId
          ? success(
              JSON.stringify({
                steps: [
                  {
                    id: 'document',
                    title: 'Write the requested document',
                    instruction: 'Create the document from the supplied requirements',
                    kind: 'general',
                    transport: 'cli',
                    dependsOn: [],
                  },
                ],
              }),
            )
          : success('Synthetic document completed'),
  });
  const submitted = await submit(f.workspace, {
    ...message,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: 'Create a document and a companion summary.',
  });
  const completed = await finish(f.workspace, submitted.workflow.id),
    recorded = runs(f.controller, completed);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.planning?.strategy, 'model');
  assert.equal(completed.plan.length, 1);
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['grok-a', 'grok-b', 'grok-b'],
  );
  assert.equal(recorded[0]!.stepId, undefined);
  assert.equal(recorded[1]!.stepId, undefined);
  assert.equal(recorded[1]!.relay?.fromRunId, recorded[0]!.id);
  assert.equal(recorded[2]!.stepId, 'document');
  assert.deepEqual(
    f.calls.map((call) => call.input.permissionMode),
    ['read-only', 'read-only', 'workspace-write'],
  );
});

test('an external account change invalidates cached discovery before either preview or start can dispatch', async (t) => {
  const f = fixture(t, { script: () => success() });
  const input = {
    prompt: message.content,
    projectPath: f.directory,
    kind: 'general' as const,
    runtimeId: 'grok-a',
    allowUnknownQuota: true,
  };
  const initial = f.controller.preview(input);
  assert.equal(initial.accountFingerprint, 'synthetic-account-a');
  f.identities.set('grok-a', 'new-external-identity');
  assert.throws(() => f.controller.preview(input), RouteUnavailableError);
  await assert.rejects(f.controller.start(input));
  assert.equal(f.calls.length, 0);
  // A real successful refresh would update both observations. The fixture only
  // changes safe identity metadata, never creates or reads an authentication file.
  f.controller.targets.find((target) => target.id === 'grok-a')!.accountFingerprint = 'new-external-identity';
  f.controller.snapshots.find((snapshot) => snapshot.id === 'grok-a')!.accountFingerprint = 'new-external-identity';
  const run = await settleRun(f.controller, await f.controller.start(input));
  assert.equal(run.status, 'completed');
  assert.equal(run.account?.fingerprint, 'new-external-identity');
  assert.equal(run.route.accountFingerprint, 'new-external-identity');
  assert.equal(f.calls.length, 1);
});

test('changing the identity after a proposal requires a new confirmation even when runtime/model/effort are unchanged', async (t) => {
  const f = fixture(t, { mode: 'confirm', script: () => success() });
  const submitted = await submit(f.workspace);
  await f.workspace.tickQueue();
  const pending = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  const old = pending.routingReview!;
  assert.equal(old.proposal.accountFingerprint, 'synthetic-account-a');
  f.identities.set('grok-a', 'new-external-identity');
  f.controller.targets.find((target) => target.id === 'grok-a')!.accountFingerprint = 'new-external-identity';
  f.controller.snapshots.find((snapshot) => snapshot.id === 'grok-a')!.accountFingerprint = 'new-external-identity';
  const changed = f.workspace.confirm(pending.id, old.id);
  assert.equal(changed.status, 'waiting-confirmation');
  assert.equal(changed.routingReview?.status, 'pending');
  assert.notEqual(changed.routingReview?.id, old.id);
  assert.equal(changed.routingReview?.proposal.accountFingerprint, 'new-external-identity');
  assert.equal(f.calls.length, 0);
  f.workspace.confirm(changed.id, changed.routingReview!.id);
  const completed = await finish(f.workspace, changed.id);
  assert.equal(completed.status, 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal(runs(f.controller, completed)[0]!.account?.fingerprint, 'new-external-identity');
});

test('a confirmed account identity is checked again after approval and before queued execution', async (t) => {
  const f = fixture(t, { mode: 'confirm', script: () => success() });
  const submitted = await submit(f.workspace);
  await f.workspace.tickQueue();
  const pending = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  const oldId = pending.routingReview!.id;
  f.workspace.confirm(pending.id, oldId);
  f.identities.set('grok-a', 'post-approval-identity');
  f.controller.targets.find((target) => target.id === 'grok-a')!.accountFingerprint = 'post-approval-identity';
  f.controller.snapshots.find((snapshot) => snapshot.id === 'grok-a')!.accountFingerprint = 'post-approval-identity';
  await f.workspace.tickQueue();
  const reviewed = f.workspace.store.get<Workflow>('workflow', pending.id)!;
  assert.equal(reviewed.status, 'waiting-confirmation');
  assert.notEqual(reviewed.routingReview?.id, oldId);
  assert.equal(reviewed.routingReview?.proposal.accountFingerprint, 'post-approval-identity');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(reviewed.runIds, []);
});

test('the controller rejects a direct confirmed route when only the authenticated identity changed', async (t) => {
  const f = fixture(t, { script: () => success() });
  const input = {
    prompt: message.content,
    projectPath: f.directory,
    kind: 'general' as const,
    runtimeId: 'grok-a',
    allowUnknownQuota: true,
  };
  const proposal = f.controller.preview(input);
  const confirmedRoute = {
    runtimeId: proposal.runtimeId,
    model: proposal.model,
    effort: proposal.effort,
    accountFingerprint: proposal.accountFingerprint,
  };
  f.identities.set('grok-a', 'new-confirmed-route-identity');
  f.controller.targets.find((target) => target.id === 'grok-a')!.accountFingerprint = 'new-confirmed-route-identity';
  f.controller.snapshots.find((snapshot) => snapshot.id === 'grok-a')!.accountFingerprint =
    'new-confirmed-route-identity';
  await assert.rejects(f.controller.start({ ...input, confirmedRoute }));
  assert.equal(f.calls.length, 0);
});

test('native resume preserves a verified identity and refuses a different identity even after fresh discovery', async (t) => {
  const f = fixture(t, { script: () => success() });
  const input = {
    prompt: message.content,
    projectPath: f.directory,
    kind: 'general' as const,
    runtimeId: 'grok-a',
    allowUnknownQuota: true,
  };
  const first = await settleRun(f.controller, await f.controller.start(input));
  const resumed = await settleRun(f.controller, await f.controller.start({ ...input, resumeRunId: first.id }));
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.parentRunId, first.id);
  assert.equal(f.calls[1]!.nativeSessionId, first.nativeSessionId);
  assert.ok(f.argv[1]!.includes('--resume'));
  assert.equal(resumed.account?.fingerprint, first.account?.fingerprint);
  f.identities.set('grok-a', 'replacement-identity');
  f.controller.targets.find((target) => target.id === 'grok-a')!.accountFingerprint = 'replacement-identity';
  f.controller.snapshots.find((snapshot) => snapshot.id === 'grok-a')!.accountFingerprint = 'replacement-identity';
  await assert.rejects(f.controller.start({ ...input, resumeRunId: first.id }));
  assert.equal(f.calls.length, 2, 'the old native session is never sent to the replacement account');
});

test('legacy managed Grok sessions without a recorded identity cannot be resumed or silently relayed', async (t) => {
  const f = fixture(t, { script: () => success() });
  const input = {
    prompt: message.content,
    projectPath: f.directory,
    kind: 'general' as const,
    runtimeId: 'grok-a',
    allowUnknownQuota: true,
  };
  const first = await settleRun(f.controller, await f.controller.start(input));
  delete first.account;
  delete first.route.accountFingerprint;
  f.controller.store.saveRun(first);
  await assert.rejects(f.controller.start({ ...input, resumeRunId: first.id }));
  assert.equal(f.calls.length, 1);
  f.identities.set('grok-a', undefined);
  await assert.rejects(f.controller.start({ ...input, resumeRunId: first.id }));
  assert.equal(f.calls.length, 1);
});

test('the default native Grok profile receives the same identity-bound resume protection as managed profiles', async (t) => {
  const f = fixture(t, { script: () => success() });
  const native: RuntimeTarget = { ...f.targets[0]!, id: 'grok-native', label: 'Synthetic default profile' };
  delete native.accountId;
  delete native.accountHome;
  f.controller.targets = [native, ...f.controller.targets.filter((target) => target.id !== 'grok-a')];
  f.controller.snapshots = [observed(native), ...f.controller.snapshots.filter((snapshot) => snapshot.id !== 'grok-a')];
  f.identities.set(native.id, native.accountFingerprint);
  const input = {
    prompt: message.content,
    projectPath: f.directory,
    kind: 'general' as const,
    runtimeId: native.id,
    allowUnknownQuota: true,
  };
  const first = await settleRun(f.controller, await f.controller.start(input));
  assert.equal(first.account?.id, 'grok-native');
  assert.equal(first.account?.fingerprint, 'synthetic-account-a');
  f.identities.set(native.id, 'changed-default-profile');
  native.accountFingerprint = 'changed-default-profile';
  f.controller.snapshots.find((snapshot) => snapshot.id === native.id)!.accountFingerprint = 'changed-default-profile';
  await assert.rejects(f.controller.start({ ...input, resumeRunId: first.id }));
  assert.equal(f.calls.length, 1);
});

test('unknown live identities cannot dispatch through stale account aliases', async (t) => {
  const f = fixture(t, { script: () => success(), fingerprints: ['duplicate-account', 'duplicate-account'] });
  const input = {
    prompt: message.content,
    projectPath: f.directory,
    kind: 'general' as const,
    provider: 'grok' as const,
    allowUnknownQuota: true,
  };
  f.identities.set('grok-a', undefined);
  f.identities.set('grok-b', undefined);
  assert.throws(() => f.controller.preview(input), RouteUnavailableError);
  await assert.rejects(f.controller.start(input));
  for (const runtimeId of ['grok-a', 'grok-b']) await assert.rejects(f.controller.start({ ...input, runtimeId }));
  assert.equal(f.calls.length, 0);
});

test('choosing Grok as the provider allows same-provider account relay while rejecting other provider preferences', async (t) => {
  const f = fixture(t);
  const competitor: RuntimeTarget = {
    id: 'codex-fixture',
    provider: 'codex',
    label: 'Synthetic preferred provider',
    command: 'fixture-only',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
  };
  f.controller.targets.push(competitor);
  f.controller.snapshots.push({
    ...observed(competitor),
    models: [{ id: 'gpt-fixture', label: 'Synthetic alternative', efforts: ['medium'] }],
  });
  f.controller.settings.routePreferencesEnabled = true;
  f.controller.settings.architectureProvider = 'codex';
  let otherProviderCalls = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    otherProviderCalls++;
    throw new Error('A provider pin must exclude this adapter');
  });
  const submitted = await submit(f.workspace, { ...message, provider: 'grok' });
  const completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(otherProviderCalls, 0);
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['grok-a', 'grok-b'],
  );
  assert.equal(completed.input.provider, 'grok');
  assert.equal(completed.input.runtimeId, undefined);
  assert.ok(f.calls.every((call) => call.input.provider === 'grok'));
});

test('an in-flight failure stays with its original identity after the profile changes, excluding old aliases and allowing the other account', async (t) => {
  const f = fixture(t, {
    fingerprints: ['identity-A', 'identity-A', 'identity-B'],
    before: (context, index) => {
      if (index !== 0) return;
      assert.equal(context.target.accountFingerprint, 'identity-A');
      // Simulate the metadata a completed refresh publishes after an external
      // login change while the original CLI is still serving identity A.
      f.identities.set('grok-a', 'identity-B');
      f.controller.targets.find((target) => target.id === 'grok-a')!.accountFingerprint = 'identity-B';
      f.controller.snapshots.find((snapshot) => snapshot.id === 'grok-a')!.accountFingerprint = 'identity-B';
      assert.equal(
        context.target.accountFingerprint,
        'identity-A',
        'the running executor keeps a private copy of its original identity',
      );
    },
  });
  const submitted = await submit(f.workspace, { ...message, autoEscalate: true });
  const completed = await finish(f.workspace, submitted.workflow.id),
    [failed, relayed] = runs(f.controller, completed);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['grok-a', 'grok-c'],
  );
  assert.equal(failed!.account?.fingerprint, 'identity-A');
  assert.equal(failed!.error, 'quota-or-rate-limit');
  assert.equal(relayed!.account?.fingerprint, 'identity-B');
  assert.equal(relayed!.relay?.fromRunId, failed!.id);
  const health = f.controller.accountHealth.report();
  assert.equal(health.length, 1);
  assert.equal(health[0]!.accountFingerprint, 'identity-A');
  for (const id of ['grok-a', 'grok-c']) {
    assert.equal(
      f.controller.accountHealth.apply(f.controller.snapshots.find((snapshot) => snapshot.id === id)!).availability,
      undefined,
      'the replacement identity must not inherit the previous identity quota failure',
    );
  }
  assert.equal(
    f.controller.accountHealth.apply(f.controller.snapshots.find((snapshot) => snapshot.id === 'grok-b')!).availability
      ?.reason,
    'quota',
  );
});

test('account identity changes hide the previous plan and quota in both resource and account views', (t) => {
  const f = fixture(t);
  const snapshot = f.controller.snapshots.find((item) => item.id === 'grok-a')!;
  snapshot.subscription = { label: 'SuperGrok', source: 'synthetic billing', observedAt: new Date().toISOString() };
  snapshot.quota = {
    status: 'known',
    source: 'synthetic billing',
    observedAt: new Date().toISOString(),
    windows: [{ id: 'week', label: '每周额度', usedPercent: 20, resetsAt: null }],
  };
  snapshot.quota.resetCredits = {
    availableCount: 3,
    details: null,
    source: 'synthetic',
    observedAt: new Date().toISOString(),
  };
  assert.equal(
    f.controller.nativeAccounts().accounts.find((item) => item.runtimeId === 'grok-a')?.subscription?.label,
    'SuperGrok',
  );
  f.identities.set('grok-a', 'different-account');
  const account = f.controller.nativeAccounts().accounts.find((item) => item.runtimeId === 'grok-a')!;
  assert.equal(account.subscription, undefined);
  assert.deepEqual(account.quota.windows, []);
  const runtime = f.controller.state().runtimes.find((item) => item.id === 'grok-a')!;
  assert.equal(runtime.subscription, undefined);
  assert.deepEqual(runtime.quota.windows, []);
  assert.equal(account.quota.resetCredits, undefined);
  assert.equal(runtime.quota.resetCredits, undefined);
});
