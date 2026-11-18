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
import { syntheticCodex, type CodexScript } from './helpers/codex-rpc.ts';
import type { ExecuteContext, MessageInput, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Explain this implementation choice.',
  mode: 'chat',
  provider: 'codex',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
};
const quota = { message: 'Private upstream diagnostic token=do-not-publish', codexErrorInfo: 'usageLimitExceeded' };
type Options = {
  decisionMode?: 'auto' | 'confirm';
  sameIdentity?: boolean;
  script?: (context: ExecuteContext, index: number) => CodexScript;
};
function observed(target: RuntimeTarget): RuntimeSnapshot {
  return {
    id: target.id,
    label: target.label,
    provider: target.provider,
    environment: target.environment,
    accountFingerprint: target.accountFingerprint,
    installed: true,
    status: 'ready',
    authMode: 'chatgpt',
    models: [{ id: 'gpt-fixture', label: 'Synthetic full model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'Synthetic account/rateLimits/read',
      observedAt: new Date().toISOString(),
      windows: [
        {
          id: 'codex:primary',
          label: 'Synthetic 5 hour window',
          usedPercent: 10,
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    },
    accounting: { mode: 'subscription', source: 'Synthetic ChatGPT account' },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
}
function fixture(t: TestContext, options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-codex-relay-')),
    dataDir = join(directory, 'data'),
    home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  const overrides: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    PATH: '',
    APPDATA: join(home, 'roaming'),
    LOCALAPPDATA: join(home, 'local'),
    XDG_CONFIG_HOME: home,
    CODEX_HOME: join(home, 'codex'),
    GROK_HOME: join(home, 'grok'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    OPENAI_API_KEY: undefined,
    CODEX_API_KEY: undefined,
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  let controller: Controller, workspace: Workspace;
  t.after(async () => {
    try {
      await workspace?.close();
      await controller?.close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.ok(
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
          basename(directory).startsWith('comborunner-codex-relay-'),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  assert.equal(resolve(homedir()), resolve(home));
  const targets: RuntimeTarget[] = ['a', 'b'].map((suffix) => ({
    id: `codex-${suffix}`,
    provider: 'codex',
    label: `Synthetic Codex ${suffix}`,
    command: 'never-spawned',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
    accountId: `synthetic-${suffix}`,
    accountHome: join(dataDir, 'accounts', `synthetic-${suffix}`),
    accountFingerprint: `identity-${options.sameIdentity ? 'a' : suffix}`,
  }));
  const identities = new Map<string, string | undefined>(
    targets.map((target) => [target.id, target.accountFingerprint]),
  );
  const store = new Store(dataDir);
  store.setConfig('targets', [
    ...targets,
    { id: 'pi-local', provider: 'pi', label: 'Disabled Pi', command: 'unused', environment: 'native', enabled: false },
  ]);
  store.close();
  controller = new Controller(directory, dataDir, {
    readAccountIdentity: (target) => identities.get(target.id),
    taskJudge: new TaskJudge({
      credential: () => undefined,
      fetch: async () => {
        throw new Error('No network permitted');
      },
    }),
  });
  clearInterval(controller.timer);
  Object.assign(controller.settings, {
    decisionMode: options.decisionMode ?? 'auto',
    taskJudgment: 'local',
    preferNative: true,
    architectureProvider: 'codex',
    routineProvider: 'codex',
    designProvider: 'codex',
  });
  controller.snapshots = targets.map(observed);
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [],
    requests: Array<Array<Record<string, unknown>>> = [];
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    const index = calls.push(context) - 1,
      stream: Array<Record<string, unknown>> = [];
    requests.push(stream);
    const script =
      options.script?.(context, index) ??
      (context.target.id === 'codex-a' ? { failure: quota, tokens: 3 } : { tokens: 11 });
    return syntheticCodex(script, stream).execute(context);
  });
  workspace = new Workspace(controller, { autoTick: false, retryMs: 20 });
  return { directory, dataDir, controller, workspace, calls, requests, identities, targets };
}
async function until(predicate: () => boolean, tick?: () => Promise<unknown>) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await tick?.();
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(predicate(), true, 'expected synthetic workflow state');
}
async function send(workspace: Workspace, patch: Partial<MessageInput> = {}) {
  const conversation = await workspace.createGeneralConversation();
  return workspace.send(conversation.id, { ...input, ...patch });
}
async function finish(workspace: Workspace, id: string) {
  await until(
    () =>
      ['completed', 'blocked', 'cancelled', 'failed'].includes(workspace.store.get<Workflow>('workflow', id)!.status),
    () => workspace.tickQueue(),
  );
  return workspace.store.get<Workflow>('workflow', id)!;
}

test('Codex typed usage limit relays A to B with unchanged model/effort, separate native threads, usage and identity records', async (t) => {
  const f = fixture(t),
    submitted = await send(f.workspace, { model: 'gpt-fixture', effort: 'high' });
  const completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['codex-a', 'codex-b'],
  );
  assert.ok(
    f.calls.every(
      (call) =>
        call.route.model === 'gpt-fixture' && call.route.effort === 'high' && call.input.permissionMode === 'read-only',
    ),
  );
  const [a, b] = completed.runIds.map((id) => f.controller.store.run(id)!);
  assert.equal(a!.error, 'quota-or-rate-limit');
  assert.equal(a!.output, '');
  assert.equal(a!.account?.fingerprint, 'identity-a');
  assert.equal(b!.account?.fingerprint, 'identity-b');
  assert.notEqual(a!.nativeSessionId, b!.nativeSessionId);
  assert.deepEqual(b!.relay, { fromRunId: a!.id, fromRuntimeId: 'codex-a', reason: 'quota' });
  assert.ok(
    f.requests.every(
      (stream) =>
        stream.some((request) => request.method === 'thread/start') &&
        !stream.some((request) => request.method === 'thread/resume'),
    ),
  );
  const usage = f.controller.usage.report();
  assert.equal(usage.totals.totalTokens, 14);
  assert.equal(usage.perRun.length, 2);
  assert.equal(usage.byRuntime.find((row) => row.runtimeId === 'codex-a')?.totalTokens, 3);
  assert.equal(usage.byRuntime.find((row) => row.runtimeId === 'codex-b')?.totalTokens, 11);
  assert.ok(!JSON.stringify([a, b]).includes('do-not-publish'));
});

test('Codex HTTP 401 structured request error relays without treating its diagnostic as output', async (t) => {
  const f = fixture(t, {
    script: (context) =>
      context.target.id === 'codex-a'
        ? {
            requestFailure: {
              code: -32000,
              message: 'Provider error',
              data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } },
            },
          }
        : {},
  });
  const submitted = await send(f.workspace),
    completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(f.calls.length, 2);
  const [a, b] = completed.runIds.map((id) => f.controller.store.run(id)!);
  assert.equal(a!.error, 'authentication-required');
  assert.equal(a!.output, '');
  assert.equal(b!.relay?.reason, 'authentication');
  assert.equal(f.controller.accountHealth.report()[0]!.reason, 'authentication');
});

test('both Codex accounts exhausted wait without a tight retry loop and never treat WSL as a third independent account', async (t) => {
  const f = fixture(t, { script: () => ({ failure: quota }) });
  const wsl: RuntimeTarget = {
    id: 'codex-wsl',
    label: 'Synthetic WSL duplicate',
    provider: 'codex',
    command: 'unused',
    environment: 'wsl',
    enabled: true,
  };
  f.controller.targets.push(wsl);
  f.controller.snapshots.push(observed(wsl));
  const submitted = await send(f.workspace);
  await until(
    () => f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!.status === 'waiting-resource',
    () => f.workspace.tickQueue(),
  );
  const waiting = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.deepEqual(
    f.calls.map((call) => call.target.id),
    ['codex-a', 'codex-b'],
  );
  assert.ok(Date.parse(waiting.scheduling?.nextAttemptAt ?? '') > Date.now() + 30_000);
  for (let i = 0; i < 20; i++) await f.workspace.tickQueue();
  assert.equal(f.calls.length, 2);
  f.workspace.cancel(waiting.id);
  assert.equal((await finish(f.workspace, waiting.id)).status, 'cancelled');
});

test('a read-only Codex partial answer hands off with its checkpoint and no native resume', async (t) => {
  const f = fixture(t, {
    script: (context) =>
      context.target.id === 'codex-a'
        ? {
            failure: quota,
            prefix: [{ method: 'item/agentMessage/delta', params: { itemId: 'partial', delta: 'Existing answer' } }],
          }
        : {},
  });
  const submitted = await send(f.workspace),
    completed = await finish(f.workspace, submitted.workflow.id),
    failed = f.controller.store.run(completed.runIds[0]!)!;
  assert.equal(completed.status, 'completed');
  assert.equal(f.calls.length, 2);
  assert.equal(failed.output, 'Existing answer');
  assert.equal(failed.handoffCheckpoint?.safe, true);
  assert.equal(f.calls[1]!.input.permissionMode, 'read-only');
  assert.match(f.calls[1]!.input.prompt, /Existing answer/);
  assert.ok(f.requests.every((stream) => !stream.some((request) => request.method === 'thread/resume')));
});

for (const type of ['tool', 'approval'] as const)
  test(`Codex ${type} activity prevents quota replay to the second account`, async (t) => {
    const prefix =
      type === 'tool'
        ? [
            {
              method: 'item/started',
              params: {
                item: { id: 'tool', type: 'commandExecution', command: 'Synthetic command', status: 'inProgress' },
              },
            },
          ]
        : [];
    const f = fixture(t, { script: () => ({ failure: quota, prefix, approval: type === 'approval' }) });
    if (type === 'approval') f.controller.updateSettings({ toolApprovalMode: 'ask' });
    const submitted = await send(f.workspace, { autoEscalate: true });
    if (type === 'approval') {
      await until(
        () => f.controller.approvals.size === 1,
        () => f.workspace.tickQueue(),
      );
      f.controller.answerApproval([...f.controller.approvals.keys()][0]!, false);
    }
    const completed = await finish(f.workspace, submitted.workflow.id),
      failed = f.controller.store.run(completed.runIds[0]!)!;
    assert.equal(completed.status, 'blocked');
    assert.equal(f.calls.length, 1);
    assert.equal(failed.errorCode, 'quota-or-rate-limit');
    assert.match(failed.error!, /quota-or-rate-limit/);
    assert.equal(failed.handoffCheckpoint?.safe, false);
    assert.equal(failed.hadToolActivity, true);
  });

test('a duplicate Codex identity does not provide another account quota', async (t) => {
  const f = fixture(t, { sameIdentity: true }),
    submitted = await send(f.workspace, { autoEscalate: true });
  await until(
    () => f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)?.status === 'waiting-resource',
    () => f.workspace.tickQueue(),
  );
  const waiting = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(waiting.runIds.length, 1);
  assert.equal(f.controller.store.run(waiting.runIds[0]!)?.handoffCheckpoint?.safe, true);
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.controller.accountHealth.apply(f.controller.snapshots.find((snapshot) => snapshot.id === 'codex-b')!).availability
      ?.reason,
    'quota',
  );
  for (let index = 0; index < 10; index++) await f.workspace.tickQueue();
  assert.equal(f.calls.length, 1, 'the duplicate profile must not replay an exhausted account');
  f.workspace.cancel(waiting.id);
  assert.equal((await finish(f.workspace, waiting.id)).status, 'cancelled');
});

test('Codex confirmation mode keeps the approved account on a quota failure', async (t) => {
  const f = fixture(t, { decisionMode: 'confirm' }),
    submitted = await send(f.workspace);
  await f.workspace.tickQueue();
  const pending = f.workspace.store.get<Workflow>('workflow', submitted.workflow.id)!;
  assert.equal(pending.routingReview?.proposal.accountFingerprint, 'identity-a');
  assert.equal(f.calls.length, 0);
  f.workspace.confirm(pending.id, pending.routingReview!.id);
  const completed = await finish(f.workspace, pending.id);
  assert.equal(completed.status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.target.id, 'codex-a');
});

test('Codex 500 transport errors are not account exhaustion and do not trigger a relay', async (t) => {
  const f = fixture(t, {
    script: () => ({
      failure: { message: 'Provider failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 500 } } },
    }),
  });
  const submitted = await send(f.workspace, { autoEscalate: true }),
    completed = await finish(f.workspace, submitted.workflow.id);
  assert.equal(completed.status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.controller.accountHealth.report(), []);
});
