import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createPiAdapter } from '../src/server/adapters/pi.ts';
import { failureNotice, systemNoticeText } from '../src/shared/system-notices.ts';
import { redactError, runtimeError } from '../src/server/adapters/process.ts';
import { syntheticCodex } from './helpers/codex-rpc.ts';
import assert from 'node:assert/strict';
import { fork } from '../src/server/platform/test-process.ts';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_VERSION } from '../src/shared/identity.ts';
import { sandboxExecutions } from '../src/server/sandbox/execution.ts';
import { mxcRuntime } from '../src/server/sandbox/mxc-runtime.ts';
import type { SandboxRequest } from '../src/server/sandbox/policy-builder.ts';
import type { ExecuteContext, DiscoveryOptions } from '../src/shared/types.ts';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { installedPlugins } from '../src/server/plugins.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { cursorAdapter } from '../src/server/adapters/cursor.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import { defaultTargets } from '../src/server/discovery.ts';
import type { AppState, RuntimeSnapshot, RuntimeTarget, RunRecord, Workflow } from '../src/shared/types.ts';

const epoch = Date.parse('2026-09-26T12:00:00Z');

test('structured Pi and Codex failures reach saved run detail and notices; only a content filter changes the code', async (t) => {
  const f = fixture(t);
  const key = 'abcdef0123456789.ZHIPU_SYNTHETIC_SECRET';
  const prompt = 'PRIVATE_PROMPT_SENTINEL';
  const api = { ...pi, gateway: 'api' as const, apiProvider: 'zai-cn', agentDir: join(f.dataDir, 'agent') };
  const messages = [
    `HTTP 429 slow down API key ${key} Bearer BEARER_SECRET ${f.dataDir} ${api.agentDir} prompt=${prompt}`,
    'Provider finish_reason: content_filter',
    'Provider finish_reason: sensitive',
    '{"error":{"code":"1301","message":"request rejected"}}',
  ];
  let index = 0;
  for (const source of ['message_end', 'auto_retry_end', 'response', 'codex']) {
    for (const message of source === 'codex' ? ['Unauthorized token=CODEX_SECRET'] : messages) {
      const requests: Record<string, unknown>[] = [];
      const fake = createPiAdapter({
        key: () => key,
        environment: () => ({ PI_OFFLINE: '1' }),
        terminate: async () => {},
        spawn: async () => {
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            pid: 999999,
          });
          const send = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
          child.stdin.on('data', (line: Buffer) => {
            const packet = JSON.parse(line.toString());
            requests.push(packet);
            if (packet.type === 'prompt' && source === 'response') {
              send({ type: 'response', id: packet.id, success: false, error: message });
              return;
            }
            const data =
              packet.type === 'get_available_models'
                ? { models: [{ provider: 'zai-coding-cn', id: 'glm-5.3', reasoning: true }] }
                : packet.type === 'get_available_thinking_levels'
                  ? { levels: ['off', 'high'] }
                  : {};
            send({ type: 'response', id: packet.id, success: true, data });
            if (packet.type === 'prompt') {
              send(
                source === 'message_end'
                  ? {
                      type: source,
                      message: { role: 'assistant', stopReason: 'error', errorMessage: message, content: [] },
                    }
                  : { type: source, success: false, finalError: message },
              );
              send({ type: 'agent_settled' });
            }
          });
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      });
      const target = source === 'codex' ? codex : api;
      const snapshot = observed(target, f.now());
      snapshot.capabilities.toolless = true;
      f.controller.snapshots = [snapshot];
      const adapter =
        source === 'codex' ? syntheticCodex({ failure: { message, codexErrorInfo: 'unauthorized' } }) : fake;
      t.mock.method(source === 'codex' ? codexAdapter : piAdapter, 'execute', adapter.execute);
      const run: RunRecord = {
        id: `detail-${++index}`,
        prompt,
        projectPath: f.directory,
        kind: 'general',
        status: 'running',
        route: {
          runtimeId: target.id,
          model: source === 'codex' ? 'gpt-fixture' : 'zai-coding-cn/glm-5.3',
          effort: 'high',
          kind: 'general',
          reasons: [],
          warnings: [],
        },
        startedAt: new Date(epoch).toISOString(),
        output: '',
        events: [],
      };
      await f.controller.execute(
        run,
        { prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only', untrustedContent: true },
        target,
        new AbortController(),
      );
      assert.equal(run.status, 'failed');
      // A provider's content filter is the one code this upgrades: it is a policy block, not an untyped failure.
      assert.equal(run.error, /content_filter|sensitive/.test(message) ? 'provider-refused' : redactError(message));
      assert.equal(run.errorCode, run.error);
      assert.equal(run.apiProvider, target.apiProvider);
      assert.equal(f.controller.store.run(run.id)?.apiProvider, target.apiProvider);
      assert.ok(
        run.errorDetail,
        `${source}: ${run.error}; requests=${requests.map((packet) => packet.type)}; events=${JSON.stringify(run.events.map((event) => event.text))}`,
      );
      assert.doesNotMatch(
        run.errorDetail!,
        /ZHIPU_SYNTHETIC_SECRET|BEARER_SECRET|CODEX_SECRET|PRIVATE_PROMPT_SENTINEL/,
      );
      assert.ok(!run.errorDetail!.includes(f.dataDir));
      const terminal = run.events.filter((event) => event.type === 'error').at(-1)!;
      assert.equal(terminal.text, run.error);
      assert.equal(terminal.data?.detail, run.errorDetail);
      assert.equal(f.controller.store.run(run.id)?.errorDetail, run.errorDetail);
      const notice = failureNotice(
        { id: 'workflow', input: {}, runIds: [run.id], status: 'failed', error: run.error } as Workflow,
        [run],
      );
      assert.ok(notice.details?.includes(run.errorDetail!));
      if (/content_filter|sensitive|1301/.test(message))
        assert.match(notice.text, new RegExp(systemNoticeText.moderation));
      if (source !== 'codex') {
        assert.equal(requests.find((packet) => packet.type === 'set_model')?.modelId, 'glm-5.3');
        assert.equal(requests.find((packet) => packet.type === 'set_thinking_level')?.level, 'high');
        assert.equal(run.events.filter((event) => event.type === 'error').length, 1);
      }
    }
  }
});
const codex: RuntimeTarget = {
  id: 'codex-test',
  provider: 'codex',
  label: 'Codex',
  command: 'mock',
  enabled: true,
  environment: 'native',
};
const pi: RuntimeTarget = {
  id: 'pi-local',
  provider: 'pi',
  label: 'Pi',
  command: 'mock',
  enabled: true,
  environment: 'native',
};
const claude: RuntimeTarget = {
  id: 'claude-test',
  provider: 'claude',
  label: 'Claude',
  command: 'mock',
  enabled: true,
  environment: 'native',
};
const dsh: RuntimeTarget = {
  id: 'dsh-local',
  provider: 'dsh',
  label: 'Historical DSH',
  command: 'old-dsh-command',
  args: ['old-session-home'],
  enabled: true,
  environment: 'native',
};

function cleanup(directory: string) {
  const absolute = resolve(directory);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('studio-core-test-'));
  rmSync(absolute, { recursive: true, force: true });
}
function fixture(t: TestContext, seed?: (store: Store) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-core-test-'));
  const dataDir = join(directory, 'data');
  const stored = new Store(dataDir);
  stored.setConfig('targets', [{ ...codex }, { ...pi }]);
  seed?.(stored);
  const seededTargets = stored.config<RuntimeTarget[]>('targets', []);
  stored.close();
  let clock = epoch;
  const controller = new Controller(directory, dataDir, { now: () => clock });
  clearInterval(controller.timer);
  // This suite exercises synthetic transports only. New factory entries must not probe a real login.
  for (const target of controller.targets)
    if (['cursor-native', 'gemini-native'].includes(target.id))
      Object.assign(target, { enabled: false, executionDisabledByUser: true });
  controller.store.setConfig('targets', controller.targets);
  // These fixtures use Pi as a generic API harness. The product keeps direct Pi locked by default,
  // so allow it here and restore only the Pi targets the test seeded as enabled.
  controller.settings.allowDirectPiApi = true;
  for (const target of controller.targets)
    if (target.provider === 'pi' && !target.gateway && seededTargets.find((item) => item.id === target.id)?.enabled)
      target.enabled = true;
  t.after(async () => {
    await controller.close();
    cleanup(directory);
  });
  return {
    directory,
    dataDir,
    controller,
    now: () => clock,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}
test('state retains a stopped attention task last-run summary beyond the recent run page', (t) => {
  const { controller } = fixture(t);
  const old = {
    id: 'old-attention-run',
    status: 'failed',
    startedAt: new Date(epoch).toISOString(),
    output: 'x'.repeat(5000),
    events: [],
    projectPath: 'synthetic',
    prompt: 'Synthetic task',
    kind: 'general',
    route: { runtimeId: 'mock', model: 'mock', kind: 'general', reasons: [], warnings: [] },
    taskOutcome: { status: 'failed', source: 'executor-tool', summary: 'Missing fixture' },
  } as RunRecord;
  controller.store.saveRun(old);
  for (let i = 0; i < 210; i++)
    controller.store.saveRun({
      ...old,
      id: `new-${i}`,
      startedAt: new Date(epoch + i + 1).toISOString(),
      status: 'completed',
      taskOutcome: undefined,
    });
  const workflow = {
    id: 'attention',
    conversationId: 'chat',
    status: 'failed',
    runIds: [old.id],
    updatedAt: new Date().toISOString(),
  } as Workflow;
  controller.workspaceState = () => ({
    conversations: [{ id: 'chat' } as NonNullable<AppState['conversations']>[number]],
    workflows: [workflow],
  });
  t.mock.method(controller.store, 'run', () => {
    throw Error('Must not load full output');
  });
  assert.equal(
    controller.store.runSummaries().some((run) => run.id === old.id),
    false,
  );
  const summary = controller.state().runs.find((run) => run.id === old.id);
  assert.equal(summary?.taskOutcome?.summary, 'Missing fixture');
  assert.ok(summary?.summary);
  assert.ok(summary.output.length <= 1000);
  workflow.supersededAt = new Date().toISOString();
  assert.equal(
    controller.state().runs.some((run) => run.id === old.id),
    false,
  );
  delete workflow.supersededAt;
  workflow.updatedAt = new Date(Date.now() - 15 * 86_400_000).toISOString();
  assert.equal(
    controller.state().runs.some((run) => run.id === old.id),
    false,
  );
  workflow.updatedAt = new Date().toISOString();
  workflow.attentionDismissedAt = new Date(epoch).toISOString();
  assert.equal(
    controller.state().runs.some((run) => run.id === old.id),
    false,
  );
});

test('automatic reply identity defaults on, turns the old saved default on once, then keeps an opt-out', (t) => {
  for (const [enabled, migrated, shown] of [
    [undefined, false, true],
    // Saved before 10-31, false was only the old default.
    [false, false, true],
    [true, false, true],
    [false, true, false],
  ] as const) {
    const f = fixture(t, (store) => {
      store.setConfig('settings', enabled === undefined ? {} : { showAutomaticReplyIdentity: enabled });
      if (migrated) store.setConfig('replyIdentityDefaultMigration', { completed: true });
    });
    assert.equal(f.controller.settings.showAutomaticReplyIdentity, shown);
  }
});

test('app update setting persists across controller reloads and disabled checks never fetch', async (t) => {
  const f = fixture(t);
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  assert.notEqual(f.controller.settings.updateCheck, false);
  for (const enabled of [false, true]) {
    f.controller.updateSettings({ updateCheck: enabled });
    clearInterval(f.controller.timer);
    assert.equal(
      f.controller.store.config<{ updateCheck: boolean }>('settings', { updateCheck: !enabled }).updateCheck,
      enabled,
    );
    const reopened = new Controller(f.directory, f.dataDir, { now: () => epoch });
    clearInterval(reopened.timer);
    try {
      assert.equal(reopened.settings.updateCheck, enabled);
      assert.equal(reopened.state().settings.updateCheck, enabled);
      await reopened.appUpdateCheck.tick();
      assert.equal(request.mock.callCount(), enabled ? 1 : 0);
    } finally {
      await reopened.close();
    }
  }
});

function observed(target: RuntimeTarget, at: number, status: RuntimeSnapshot['status'] = 'ready'): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: target.environment,
    installed: status !== 'missing',
    status,
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low'] }],
    quota: {
      status: target.provider === 'codex' ? 'known' : 'unknown',
      source: 'mock',
      observedAt: new Date(at).toISOString(),
      windows: [],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date(at).toISOString(),
  };
}

test('Grok discovery remembers the handshake and only retries a newer startup failure', async (t) => {
  const target: RuntimeTarget = {
    id: 'grok-synthetic',
    provider: 'grok',
    label: 'Synthetic',
    command: 'synthetic',
    environment: 'native',
    enabled: true,
  };
  const f = fixture(t, (store) => store.setConfig('targets', [target]));
  const calls: NonNullable<DiscoveryOptions['grokHandshake']>[] = [];
  t.mock.method(grokAdapter, 'discover', async (_target: RuntimeTarget, options?: DiscoveryOptions) => {
    const check = options!.grokHandshake!;
    calls.push(check);
    const snapshot = observed(target, f.now());
    snapshot.version = '1.0.67';
    snapshot.capabilities.steer = check.lastPassedSteer ?? false;
    if (check.lastPassedVersion !== snapshot.version || check.afterStartupFailure)
      snapshot.grokHandshakeAttempt = { passed: true };
    return snapshot;
  });
  const discover = () => f.controller['discoverTarget'](target);
  const first = await discover();
  assert.equal(first.capabilities.steer, false);
  f.controller.snapshots = [first];
  f.advance(1000);
  f.controller.store.saveRun({
    id: 'grok-failure',
    status: 'failed',
    route: { runtimeId: target.id },
    startedAt: new Date(f.now()).toISOString(),
    endedAt: new Date(f.now()).toISOString(),
    startupFailure: { exitCode: 1, elapsedMs: 1 },
    events: [],
    output: '',
  } as unknown as RunRecord);
  f.advance(1);
  const second = await discover();
  assert.equal(calls[1]?.afterStartupFailure, true);
  f.controller.snapshots = [second];
  f.advance(1000);
  const third = await discover();
  assert.equal(calls[2]?.afterStartupFailure, false);
  assert.equal(calls[2]?.lastPassedVersion, '1.0.67');
  assert.equal(calls[2]?.lastPassedSteer, false);
  assert.equal(third.capabilities.steer, false);
});

test('controller prepares sandbox only for execute, passes it to the adapter, then reads learning results', async (t) => {
  const f = fixture(t, (store) => store.setConfig('targets', [pi]));
  f.controller.settings.sandbox = { pi: 'learn' };
  const directory = join(f.directory, 'learning');
  mkdirSync(directory);
  const request: SandboxRequest = {
    provider: 'pi',
    runTemp: directory,
    reportDirectory: directory,
    fallback: { allowDaclMutation: false },
  };
  let preparations = 0,
    executions = 0,
    disposed = false;
  t.mock.method(sandboxExecutions, 'prepare', async () => {
    preparations++;
    return {
      request,
      dispose: async () => {
        disposed = true;
      },
    };
  });
  t.mock.method(piAdapter, 'discover', async (_target: RuntimeTarget, options?: DiscoveryOptions) => {
    assert.equal((options as Record<string, unknown> | undefined)?.sandbox, undefined);
    return observed(pi, f.now());
  });
  await f.controller.refresh();
  assert.equal(preparations, 0);
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    executions++;
    assert.equal(ctx.sandbox, request);
    assert.equal(ctx.runTemp, directory);
    writeFileSync(
      join(directory, 'denials.json'),
      JSON.stringify({ denials: [{ resource: '192.0.2.2:443', resourceType: 'network', accessType: 'connect' }] }),
    );
    return { output: 'synthetic completed' };
  });
  const run: RunRecord = {
    id: 'sandbox-fixture',
    prompt: 'synthetic',
    projectPath: f.directory,
    kind: 'general',
    status: 'running',
    route: { runtimeId: pi.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
    startedAt: new Date(epoch).toISOString(),
    output: '',
    events: [],
  };
  await f.controller.execute(
    run,
    { prompt: run.prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only' },
    pi,
    new AbortController(),
  );
  assert.equal(preparations, 1);
  assert.equal(executions, 1);
  assert.equal(disposed, true);
  assert.equal(f.controller.sandboxLearning.list()[0]?.entries[0]?.resource, '192.0.2.2:443');
  assert.ok(run.events.some((event) => event.text === '沙箱学习模式：本次不拦截，只记录访问。'));
});

function learningFixture(t: TestContext) {
  const f = fixture(t, (store) => store.setConfig('targets', [pi]));
  f.controller.settings.sandbox = { pi: 'learn' };
  f.controller.snapshots = [observed(pi, f.now())];
  const directory = join(f.directory, 'learning');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'denials.json'),
    JSON.stringify({ denials: [{ resource: '192.0.2.3:443', resourceType: 'network', accessType: 'connect' }] }),
  );
  const request: SandboxRequest = {
    provider: 'pi',
    runTemp: directory,
    reportDirectory: directory,
    fallback: { allowDaclMutation: false },
  };
  const prepare = t.mock.method(sandboxExecutions, 'prepare', async () => {
    return f.controller.settings.sandbox?.pi === 'learn' ? { request, dispose: async () => {} } : undefined;
  });
  let sequence = 0;
  async function execute() {
    const run: RunRecord = {
      id: `learning-fixture-${++sequence}`,
      prompt: 'synthetic',
      projectPath: f.directory,
      kind: 'general',
      status: 'running',
      route: { runtimeId: pi.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
      startedAt: new Date(epoch).toISOString(),
      output: '',
      events: [],
    };
    await f.controller.execute(
      run,
      { prompt: run.prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only' },
      pi,
      new AbortController(),
    );
    return run;
  }
  return { ...f, request, prepare, execute };
}

const learningFallbackNotice = '沙箱学习模式启动失败，本次按正常方式运行';

test('controller sandbox learning unsupported by SDK 1.0.0 uses normal execution and preserves learning preference', async (t) => {
  const status = {
    available: true,
    reason: 'ready' as const,
    message: '可用 · 进程容器',
    sdkVersion: '1.0.0',
    captureDenialsStreamingSupported: false,
    learningUnavailableReason: '学习模式暂不可用：当前 MXC SDK（1.0.0）在记录拒绝时会崩溃，SDK 修复后自动恢复',
  };
  const probe = t.mock.method(mxcRuntime, 'probe', async () => status);
  t.mock.method(mxcRuntime, 'status', () => status);
  const f = fixture(t, (store) => {
    store.setConfig('targets', [pi]);
    store.setConfig('settings', { sandbox: { pi: 'learn' } });
  });
  f.controller.snapshots = [observed(pi, f.now())];
  const adapter = t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    assert.equal(ctx.sandbox, undefined);
    assert.equal(ctx.runTemp, undefined);
    return { output: 'synthetic ordinary execution completed' };
  });
  // Exercise the real prepare path: the capability gate must return before temp/profile work.
  for (let sequence = 1; sequence <= 4; sequence++) {
    const run: RunRecord = {
      id: `unsupported-learning-${sequence}`,
      prompt: 'synthetic',
      projectPath: f.directory,
      kind: 'general',
      status: 'running',
      route: { runtimeId: pi.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
      startedAt: new Date(epoch).toISOString(),
      output: '',
      events: [],
    };
    await f.controller.execute(
      run,
      { prompt: run.prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only' },
      pi,
      new AbortController(),
    );
    assert.equal(run.status, 'completed');
    assert.ok(!run.events.some((event) => event.text?.includes('沙箱学习')));
    assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi, undefined);
    assert.equal(f.controller.settings.sandbox?.pi, 'learn');
    assert.equal(
      f.controller.store.config<{ sandbox: { pi: string } }>('settings', { sandbox: { pi: '' } }).sandbox.pi,
      'learn',
    );
  }
  assert.equal(adapter.mock.callCount(), 4);
  assert.equal(probe.mock.callCount(), 4);
  assert.deepEqual(f.controller.sandboxLearning.list(), []);
  assert.deepEqual(f.controller.store.config('sandboxLearningFailures', {}), {});
});

test('controller learning startup failures fall back once and persist off after three failures', async (t) => {
  const f = learningFixture(t);
  let sandboxLaunches = 0;
  const adapter = t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (ctx.sandbox) {
      sandboxLaunches++;
      ctx.onSandboxFailure?.('sandbox-helper-crashed', 'startup');
      ctx.onSandboxFailure?.('sandbox-helper-crashed', 'startup');
    }
    return { output: 'synthetic fallback completed' };
  });
  for (let count = 1; count <= 3; count++) {
    const run = await f.execute();
    assert.equal(run.status, 'completed');
    assert.equal(run.events.filter((event) => event.text === learningFallbackNotice).length, 1);
    assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi?.consecutiveFailures, count);
  }
  assert.equal(f.controller.settings.sandbox?.pi, 'off');
  assert.equal(
    f.controller.store.config<{ sandbox: { pi: string } }>('settings', { sandbox: { pi: '' } }).sandbox.pi,
    'off',
  );
  assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi?.autoDisabled, true);
  assert.equal(
    f.controller.store.config<Record<string, { autoDisabled: boolean }>>('sandboxLearningFailures', {}).pi
      ?.autoDisabled,
    true,
  );
  assert.deepEqual(f.controller.sandboxLearning.list(), []);
  const fourth = await f.execute();
  assert.equal(fourth.status, 'completed');
  assert.equal(fourth.events.filter((event) => event.text === learningFallbackNotice).length, 0);
  assert.equal(sandboxLaunches, 3);
  assert.equal(adapter.mock.callCount(), 4);
});

test('controller successful sandbox learning launch resets consecutive startup failures', async (t) => {
  const f = learningFixture(t);
  let succeed = false;
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (succeed) ctx.onSandboxSuccess?.();
    else ctx.onSandboxFailure?.('sandbox-helper-crashed', 'startup');
    return { output: 'synthetic completed' };
  });
  await f.execute();
  await f.execute();
  assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi?.consecutiveFailures, 2);
  succeed = true;
  assert.equal((await f.execute()).status, 'completed');
  assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi, undefined);
  succeed = false;
  await f.execute();
  assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi?.consecutiveFailures, 1);
  assert.equal(f.controller.settings.sandbox?.pi, 'learn');
});

test('controller sandbox learning preparation failure uses normal execution without spurious reports', async (t) => {
  const f = learningFixture(t);
  f.prepare.mock.mockImplementation(async () => {
    throw Object.assign(new Error('synthetic private diagnostic'), { code: 'backend_error', nativeCode: '0x80070005' });
  });
  const adapter = t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    assert.equal(ctx.sandbox, undefined);
    assert.equal(ctx.runTemp, undefined);
    return { output: 'synthetic normal completed' };
  });
  const run = await f.execute();
  assert.equal(run.status, 'completed');
  assert.equal(adapter.mock.callCount(), 1);
  assert.equal(run.events.filter((event) => event.text === learningFallbackNotice).length, 1);
  assert.ok(!run.events.some((event) => event.text?.includes('学习记录未生成')));
  assert.deepEqual(f.controller.sandboxLearning.list(), []);
  assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi?.code, '0x80070005');
  assert.ok(!JSON.stringify(run.events).includes('synthetic private diagnostic'));
});

test('controller sandbox learning runtime failure after readiness fails without replaying execution', async (t) => {
  const f = learningFixture(t);
  const adapter = t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.onSandboxSuccess?.();
    ctx.onSandboxFailure?.('sandbox-helper-crashed', 'runtime');
    throw new Error('sandbox-helper-crashed');
  });
  const run = await f.execute();
  assert.equal(run.status, 'failed');
  assert.equal(adapter.mock.callCount(), 1);
  assert.equal(run.events.filter((event) => event.text === learningFallbackNotice).length, 0);
  assert.equal(run.events.filter((event) => event.text === '沙箱学习进程异常退出，任务执行状态无法确认。').length, 1);
  assert.deepEqual(f.controller.sandboxLearning.list(), []);
  assert.equal(f.controller.state().sandboxStatus?.learningFailures?.pi?.consecutiveFailures, 1);
});

test('old DSH targets and history remain stored but cannot discover, execute, or silently select a replacement', async (t) => {
  const historical: RunRecord = {
    id: 'old-dsh-run',
    prompt: 'old task',
    projectPath: 'old-project',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: dsh.id, model: 'old-model', kind: 'general', reasons: [], warnings: [] },
    startedAt: new Date(epoch).toISOString(),
    endedAt: new Date(epoch).toISOString(),
    output: 'old result',
    nativeSessionId: 'old-session',
    events: [{ type: 'usage', at: new Date(epoch).toISOString(), data: { totalTokens: 17, eventId: 'old-usage' } }],
  };
  const f = fixture(t, (store) => {
    store.setConfig('targets', [dsh, { ...pi, enabled: false }]);
    store.setConfig('settings', {
      designProvider: 'dsh',
      architectureProvider: 'dsh',
      routineProvider: 'dsh',
      refreshSeconds: 120,
    });
    store.saveRun(historical);
  });
  const { controller } = f;
  assert.deepEqual(
    controller.targets.find((target) => target.id === dsh.id),
    { ...dsh, enabled: false },
  );
  assert.equal(controller.settings.designProvider, 'claude');
  assert.equal(controller.settings.architectureProvider, 'codex');
  assert.equal(controller.settings.routineProvider, 'codex');
  assert.equal(controller.settings.refreshSeconds, 120);
  const originalPreferences = {
    designProvider: 'dsh',
    architectureProvider: 'dsh',
    routineProvider: 'dsh',
    migratedAt: new Date(epoch).toISOString(),
  };
  assert.deepEqual(controller.store.config('legacyDshRoutingPreferences', null), originalPreferences);
  assert.deepEqual(controller.store.run(historical.id), historical);
  await controller.usageHistoryReady;
  assert.equal(controller.usage.report({ runtimeId: dsh.id }).totals.totalTokens, 17);
  await controller.refresh();
  assert.deepEqual(controller.snapshots, []);
  assert.throws(() => controller.updateTarget(dsh.id, { enabled: true }), /核心版移出/);
  assert.throws(() => controller.updateSettings({ designProvider: 'dsh' }), /核心版移出/);
  controller.updateTarget(dsh.id, { accountingMode: 'usage' });
  await controller.refresh();
  assert.equal(controller.targets.find((target) => target.id === dsh.id)?.enabled, false);
  const input = {
    prompt: 'must not invoke a model',
    projectPath: f.directory,
    kind: 'general' as const,
    runtimeId: dsh.id,
  };
  assert.throws(
    () => controller.preview(input),
    (error) => error instanceof RouteUnavailableError && error.kind === 'unavailable',
  );
  await assert.rejects(controller.start(input), /核心版移出/);
  await assert.rejects(controller.start({ ...input, runtimeId: undefined, resumeRunId: historical.id }), /核心版移出/);
  assert.equal(controller.store.runSummaries().length, 1);

  const workspace = new Workspace(controller, { autoTick: false });
  try {
    const project = await workspace.createProject(f.directory),
      conversation = workspace.createConversation(project.id);
    const queued = await workspace.send(conversation.id, {
      content: input.prompt,
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      runtimeId: dsh.id,
    });
    await workspace.tickQueue();
    for (let i = 0; i < 4; i++) await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    const workflow = workspace.store.get<Workflow>('workflow', queued.workflow.id)!;
    assert.equal(workflow.status, 'blocked');
    assert.match(workflow.error || '', /核心版移出/);
    assert.deepEqual(workflow.runIds, []);
  } finally {
    await workspace.close();
  }
  assert.equal(controller.store.run(historical.id)?.nativeSessionId, 'old-session');
  assert.equal(controller.usage.report({ runtimeId: dsh.id }).totals.totalTokens, 17);
  assert.equal(controller.state().app.version, APP_VERSION);
  assert.equal(controller.state().app.name, 'PugPort');
  assert.equal('jev' in controller.state(), false);
  assert.ok(!controller.state().plugins.some((plugin) => plugin.id === 'dsh'));
  const reopened = new Controller(f.directory, f.dataDir, { now: () => epoch + 86400_000 });
  clearInterval(reopened.timer);
  try {
    assert.equal(
      reopened.store.config<RuntimeTarget[]>('targets', []).find((target) => target.id === dsh.id)?.enabled,
      false,
    );
    assert.deepEqual(reopened.store.run(historical.id), historical);
    assert.deepEqual(reopened.store.config('legacyDshRoutingPreferences', null), originalPreferences);
    assert.equal(reopened.settings.designProvider, 'claude');
  } finally {
    await reopened.close();
  }
});

test('an existing DSH preference backup is never replaced by a later migration', async (t) => {
  const original = { designProvider: 'dsh', migratedAt: '2026-09-25T12:00:00.000Z' };
  const { controller } = fixture(t, (store) => {
    store.setConfig('legacyDshRoutingPreferences', original);
    store.setConfig('settings', { routineProvider: 'dsh', designProvider: 'pi' });
  });
  assert.deepEqual(controller.store.config('legacyDshRoutingPreferences', null), original);
  assert.equal(controller.settings.routineProvider, 'codex');
  assert.equal(controller.settings.designProvider, 'pi');
});

test('fresh default targets never create a WSL execution entry', () => {
  const targets = defaultTargets();
  assert.ok(targets.some((target) => target.id === 'codex-native'));
  assert.ok(targets.every((target) => target.environment === 'native' && target.id !== 'codex-wsl'));
});

test('retired WSL profiles cannot revive through discovery, API actions, queued continuation or restart while history survives', async (t) => {
  const legacy: RuntimeTarget = {
    ...codex,
    id: 'custom-linux-profile',
    label: 'Historical Linux profile',
    environment: 'wsl',
    command: 'custom-codex',
    args: ['--old-profile'],
  };
  const reserved: RuntimeTarget = { ...codex, id: 'codex-wsl', label: 'Legacy reserved WSL ID' };
  const historical: RunRecord = {
    id: 'old-wsl-run',
    prompt: 'historical task',
    projectPath: 'old-project',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: legacy.id, model: 'old-model', kind: 'general', reasons: [], warnings: [] },
    startedAt: new Date(epoch).toISOString(),
    endedAt: new Date(epoch).toISOString(),
    output: 'preserve prior work',
    nativeSessionId: 'old-linux-session',
    events: [{ type: 'usage', at: new Date(epoch).toISOString(), data: { totalTokens: 23, eventId: 'old-wsl-usage' } }],
  };
  const f = fixture(t, (store) => {
    store.setConfig('targets', [legacy, reserved, { ...pi, enabled: false }]);
    store.saveRun(historical);
  });
  const { controller } = f;
  const discovery = t.mock.method(codexAdapter, 'discover', async () => {
    throw new Error('retired WSL must never be discovered');
  });
  const execute = t.mock.method(codexAdapter, 'execute', async () => {
    throw new Error('retired WSL must never execute');
  });
  for (const target of [legacy, reserved]) {
    assert.deepEqual(
      controller.targets.find((item) => item.id === target.id),
      { ...target, enabled: false },
    );
    assert.throws(() => controller.updateTarget(target.id, { enabled: true }), /WSL/);
    // A stale in-memory entry must not bypass the permanent retirement gate.
    controller.targets.find((item) => item.id === target.id)!.enabled = true;
  }
  await controller.refresh();
  assert.equal(discovery.mock.callCount(), 0);
  assert.deepEqual(controller.snapshots, []);
  controller.snapshots = [observed(legacy, epoch), observed(reserved, epoch)];
  const input = {
    prompt: 'must not invoke a model',
    projectPath: f.directory,
    kind: 'general' as const,
    runtimeId: legacy.id,
  };
  for (const runtimeId of [legacy.id, reserved.id]) {
    assert.throws(
      () => controller.preview({ ...input, runtimeId }),
      (error) => error instanceof RouteUnavailableError && error.kind === 'unavailable' && /WSL/.test(error.message),
    );
    await assert.rejects(controller.start({ ...input, runtimeId }), /WSL/);
    await assert.rejects(controller.testConnection(runtimeId), /WSL/);
    await assert.rejects(controller.handoff(historical.id, { runtimeId }), /WSL/);
  }
  await assert.rejects(controller.start({ ...input, runtimeId: undefined, resumeRunId: historical.id }), /WSL/);
  assert.equal(controller.store.runSummaries().length, 1);

  const workspace = new Workspace(controller, { autoTick: false });
  try {
    const project = await workspace.createProject(f.directory),
      conversation = workspace.createConversation(project.id);
    const queued = await workspace.send(conversation.id, {
      content: input.prompt,
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      runtimeId: legacy.id,
    });
    const settle = async (workflowId: string) => {
      await workspace.tickQueue();
      // History retrieval runs in a worker on follow-up messages. Wait for the actual routing outcome,
      // rather than assuming four main-thread microtasks also finish worker startup and its response.
      for (let i = 0; i < 500; i++) {
        if (workspace.store.get<Workflow>('workflow', workflowId)?.status === 'blocked') return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    };
    await settle(queued.workflow.id);
    const blocked = workspace.store.get<Workflow>('workflow', queued.workflow.id)!;
    assert.equal(blocked.status, 'blocked');
    assert.match(blocked.error || '', /WSL/);
    assert.deepEqual(blocked.runIds, []);
    const continued = await workspace.continue(blocked.id);
    assert.equal(
      continued.workflow.input.runtimeId,
      legacy.id,
      'continuation must not silently turn a retired fixed route into automatic native dispatch',
    );
    await settle(continued.workflow.id);
    assert.equal(workspace.store.get<Workflow>('workflow', continued.workflow.id)?.status, 'blocked');
    assert.equal(controller.store.runSummaries().length, 1);
  } finally {
    await workspace.close();
  }
  assert.equal(execute.mock.callCount(), 0);
  assert.deepEqual(controller.store.run(historical.id), historical);
  assert.equal(controller.usage.report({ runtimeId: legacy.id }).totals.totalTokens, 23);
  const reopened = new Controller(f.directory, f.dataDir, { now: () => epoch });
  clearInterval(reopened.timer);
  try {
    for (const target of [legacy, reserved])
      assert.deepEqual(
        reopened.targets.find((item) => item.id === target.id),
        { ...target, enabled: false },
      );
    assert.deepEqual(reopened.store.run(historical.id), historical);
    assert.equal(reopened.usage.report({ runtimeId: legacy.id }).totals.totalTokens, 23);
  } finally {
    await reopened.close();
  }
});

test('fresh core configuration adds Cursor and Pi but never adds Gemini or DSH', async (t) => {
  const { controller } = fixture(t, (store) => store.setConfig('targets', []));
  assert.deepEqual(
    controller.targets.map((target) => target.provider),
    ['cursor', 'pi'],
  );
});

test('factory CLI migration preserves other saved profiles and removes retired Gemini profiles', (t) => {
  const saved: RuntimeTarget[] = [
    { ...codex, enabled: false, executionDisabledByUser: true },
    { ...claude, provider: 'cursor', commandDiscovery: 'fixed' },
    { ...codex, id: 'gemini-wsl', provider: 'gemini', environment: 'wsl', enabled: false },
    { ...dsh, enabled: false },
  ];
  const { controller } = fixture(t, (store) => store.setConfig('targets', saved));
  assert.deepEqual(
    controller.targets.filter((target) => target.provider !== 'pi'),
    saved.filter((target) => target.provider !== 'gemini'),
  );
});

test('factory CLI migration adds newly supported providers once and preserves later deletions', async (t) => {
  const f = fixture(t, (store) => {
    store.setConfig('targets', [{ ...pi, enabled: false }]);
    store.setConfig('nativeCliFactoryMigration', { providers: ['codex', 'claude', 'grok'] });
  });
  assert.deepEqual(
    f.controller.targets.map((target) => target.id),
    ['pi-local', 'cursor-native'],
  );
  f.controller.store.setConfig('targets', [{ ...pi, enabled: false }]);
  const reopened = new Controller(f.directory, f.dataDir, { now: f.now });
  clearInterval(reopened.timer);
  try {
    assert.deepEqual(
      reopened.targets.map((target) => target.id),
      ['pi-local'],
    );
  } finally {
    await reopened.close();
  }
});

test('periodic discovery retains subscription polling while caching usage catalogs and unhealthy targets', async (t) => {
  const f = fixture(t);
  f.controller.targets.push({ ...claude });
  const codexDiscover = t.mock.method(codexAdapter, 'discover', async () => observed(codex, f.now()));
  const piDiscover = t.mock.method(piAdapter, 'discover', async () => observed(pi, f.now()));
  const claudeDiscover = t.mock.method(claudeAdapter, 'discover', async () =>
    observed(claude, f.now(), 'auth-required'),
  );
  await f.controller.refresh();
  f.advance(60000);
  await f.controller.refresh({ periodic: true });
  assert.equal(codexDiscover.mock.callCount(), 2);
  assert.equal(piDiscover.mock.callCount(), 1);
  assert.equal(claudeDiscover.mock.callCount(), 1);
  assert.equal(f.controller.snapshots.length, 3, 'non-refreshed catalog snapshots remain available');
  f.advance(4 * 60000);
  await f.controller.refresh({ periodic: true });
  assert.equal(codexDiscover.mock.callCount(), 3);
  assert.equal(piDiscover.mock.callCount(), 1);
  assert.equal(claudeDiscover.mock.callCount(), 2);
  f.advance(10 * 60000);
  await f.controller.refresh({ periodic: true });
  assert.equal(piDiscover.mock.callCount(), 2);
  await f.controller.refresh();
  assert.equal(piDiscover.mock.callCount(), 3, 'manual refresh bypasses the catalog TTL');
});

for (const provider of ['cursor', 'claude'] as const)
  test(`${provider} retries transient connection checks at the refresh interval but keeps login and protocol backoff`, async (t) => {
    const f = fixture(t);
    const cursor: RuntimeTarget = { ...codex, id: `${provider}-fixture`, provider, label: provider };
    f.controller.targets = [cursor];
    f.controller.settings.refreshSeconds = 60;
    let note = 'runtime-timeout';
    let status: RuntimeSnapshot['status'] = 'error';
    const discover = t.mock.method(provider === 'claude' ? claudeAdapter : cursorAdapter, 'discover', async () => ({
      ...observed(cursor, f.now(), status),
      note,
    }));
    for (const reason of [
      'runtime-timeout',
      'runtime-network-error',
      'runtime-process-closed',
      'runtime-request-failed',
    ]) {
      note = reason;
      await f.controller.refresh();
      const count = discover.mock.callCount();
      f.advance(29_000);
      await f.controller.refresh({ periodic: true });
      assert.equal(discover.mock.callCount(), count);
      f.advance(31_000);
      await f.controller.refresh({ periodic: true });
      assert.equal(discover.mock.callCount(), count + 1, reason);
    }
    for (const [nextStatus, reason] of [
      ['error', 'runtime-protocol-incompatible'],
      ['auth-required', 'authentication-required'],
    ] as const) {
      status = nextStatus;
      note = reason;
      await f.controller.refresh();
      const count = discover.mock.callCount();
      f.advance(60_000);
      await f.controller.refresh({ periodic: true });
      assert.equal(discover.mock.callCount(), count);
      f.advance(240_000);
      await f.controller.refresh({ periodic: true });
      assert.equal(discover.mock.callCount(), count + 1);
    }
  });

test('idle usage-only polling does no discovery, broadcast, or scheduler wake until its TTL', async (t) => {
  const f = fixture(t);
  f.controller.targets = [{ ...pi }];
  const discover = t.mock.method(piAdapter, 'discover', async () => observed(pi, f.now()));
  await f.controller.refresh();
  let broadcasts = 0,
    wakes = 0;
  f.controller.on('state', () => broadcasts++);
  f.controller.on('resources-refreshed', () => wakes++);
  for (let i = 0; i < 14; i++) {
    f.advance(60000);
    await f.controller.refresh({ periodic: true });
  }
  assert.equal(discover.mock.callCount(), 1);
  assert.equal(broadcasts, 0);
  assert.equal(wakes, 0);
  f.advance(60000);
  await f.controller.refresh({ periodic: true });
  assert.equal(discover.mock.callCount(), 2);
  assert.equal(wakes, 1);
});

test('known quota windows keep polling when cumulative accounting is selected, while unhealthy targets retain their TTL', async (t) => {
  const f = fixture(t);
  f.controller.targets = [{ ...codex, accountingMode: 'usage' }];
  let status: RuntimeSnapshot['status'] = 'ready';
  const discover = t.mock.method(codexAdapter, 'discover', async () => ({
    ...observed(codex, f.now(), status),
    quota: {
      status: 'known' as const,
      source: 'mock provider window',
      observedAt: new Date(f.now()).toISOString(),
      windows: [
        { id: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: new Date(f.now() + 3600_000).toISOString() },
      ],
    },
  }));
  await f.controller.refresh();
  assert.equal(f.controller.snapshots[0]?.accounting?.mode, 'usage');
  f.advance(60000);
  await f.controller.refresh({ periodic: true });
  assert.equal(discover.mock.callCount(), 2);
  status = 'error';
  await f.controller.refresh();
  f.advance(60000);
  await f.controller.refresh({ periodic: true });
  assert.equal(discover.mock.callCount(), 3);
  f.advance(4 * 60000);
  await f.controller.refresh({ periodic: true });
  assert.equal(discover.mock.callCount(), 4);
});

test('a full refresh waiting on a periodic subset still refreshes all enabled targets', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  let calls = 0;
  t.mock.method(codexAdapter, 'discover', async () => {
    if (++calls === 2)
      await new Promise<void>((done) => {
        release = done;
      });
    return observed(codex, f.now());
  });
  const piDiscover = t.mock.method(piAdapter, 'discover', async () => observed(pi, f.now()));
  await f.controller.refresh();
  f.advance(60000);
  const periodic = f.controller.refresh({ periodic: true });
  const full = f.controller.refresh();
  release();
  await Promise.all([periodic, full]);
  assert.equal(calls, 3);
  assert.equal(piDiscover.mock.callCount(), 2);
});

test('start refreshes a missing pinned model after joining an unrelated periodic quota observation', async (t) => {
  const f = fixture(t);
  f.controller.snapshots = [observed(codex, f.now()), observed(pi, f.now())];
  f.controller.snapshots[1]!.accounting = { mode: 'usage', source: 'mock', note: '' };
  let release!: () => void;
  let calls = 0;
  t.mock.method(codexAdapter, 'discover', async () => {
    if (++calls === 1)
      await new Promise<void>((done) => {
        release = done;
      });
    return observed(codex, f.now());
  });
  const discover = t.mock.method(piAdapter, 'discover', async () => ({
    ...observed(pi, f.now()),
    models: [{ id: 'new-model', label: 'New model', efforts: ['low'] }],
  }));
  const execute = t.mock.method(piAdapter, 'execute', async () => ({ output: 'mock only' }));
  const periodic = f.controller.refresh({ periodic: true });
  const pending = f.controller.start({
    prompt: 'mock task',
    projectPath: f.directory,
    kind: 'general',
    runtimeId: pi.id,
    model: 'new-model',
  });
  release();
  const run = await pending;
  await periodic;
  assert.equal(run.route.runtimeId, pi.id);
  assert.equal(run.route.model, 'new-model');
  assert.ok(discover.mock.callCount() >= 1);
  assert.equal(execute.mock.callCount(), 1);
});

for (const shared of [true, false])
  test(
    `cancelling start during ${shared ? 'periodic discovery does not launch a follow-up full refresh' : 'independent discovery does not wait for an unrelated periodic refresh'} or any executor`,
    { timeout: 10_000 },
    async (t) => {
      const f = fixture(t);
      f.controller.snapshots = [
        observed(codex, f.now()),
        { ...observed(pi, f.now()), accounting: { mode: 'usage', source: 'mock', note: '' } },
      ];
      let release!: () => void;
      let discoveries = 0;
      const discoverCodex = t.mock.method(codexAdapter, 'discover', async () => {
        if (++discoveries === 1)
          await new Promise<void>((done) => {
            release = done;
          });
        return observed(codex, f.now());
      });
      let releasePi: (() => void) | undefined;
      const discoverPi = t.mock.method(piAdapter, 'discover', async () => {
        await new Promise<void>((done) => (releasePi = done));
        return observed(pi, f.now());
      });
      const execute = t.mock.method(shared ? codexAdapter : piAdapter, 'execute', async () => ({
        output: 'must not execute',
      }));
      const abort = new AbortController();
      let entered!: () => void;
      const entering = new Promise<void>((resolve) => (entered = resolve));
      const refresh = f.controller.refresh.bind(f.controller);
      t.mock.method(f.controller, 'refresh', (options: Parameters<Controller['refresh']>[0]) => {
        const result = refresh(options);
        if (options?.signal === abort.signal) entered();
        return result;
      });
      const periodic = f.controller.refresh({ periodic: true });
      const pending = f.controller.start(
        {
          prompt: 'cancelled mock task',
          projectPath: f.directory,
          kind: 'general',
          runtimeId: shared ? codex.id : pi.id,
          model: 'missing-model',
        },
        undefined,
        abort.signal,
      );
      const outcome = Promise.allSettled([pending]);
      try {
        await entering;
        abort.abort();
        if (shared) release();
        else releasePi!();
        const [result] = await outcome;
        assert.ok(result?.status === 'rejected');
        assert.equal(result.reason?.name, 'AbortError');
        release();
        await periodic;
        assert.equal(discoverCodex.mock.callCount(), 1);
        assert.equal(discoverPi.mock.callCount(), shared ? 0 : 1);
        assert.equal(execute.mock.callCount(), 0);
        assert.equal(f.controller.active.size, 0);
        assert.equal(f.controller.store.runSummaries().length, 0);
      } finally {
        release();
        releasePi?.();
        await Promise.all([periodic, outcome]);
      }
    },
  );

test('component inventory omits retired Jev and DSH reference entries', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-core-test-'));
  t.after(() => cleanup(directory));
  mkdirSync(join(directory, 'reports'));
  writeFileSync(
    join(directory, 'reports', 'references.json'),
    JSON.stringify({
      references: [
        {
          name: 'jev-router',
          commit: '123456789012345',
          directory: 'vendor/jev',
          sourceUrl: 'https://example.test/jev',
        },
        {
          name: 'pi2dsh',
          commit: '123456789012345',
          directory: 'vendor/pi2dsh',
          sourceUrl: 'https://example.test/pi2dsh',
        },
      ],
    }),
  );
  const plugins = installedPlugins(directory);
  assert.ok(!plugins.some((plugin) => /jev|dsh/i.test(JSON.stringify(plugin))));
});

test(
  'HTTP core resolves the source root without an override, starts without DSH and preserves disabled legacy data',
  { timeout: 20000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-core-test-')),
      dataDir = join(directory, 'data');
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const store = new Store(dataDir);
    store.setConfig('targets', [dsh, { ...pi, enabled: false }]);
    store.close();
    const entry = join(directory, 'without-dsh.mjs');
    writeFileSync(
      entry,
      `import { registerHooks } from 'node:module';\nregisterHooks({resolve(specifier,context,next){if(specifier.startsWith('@deepseek-ai/'))throw new Error('DSH is not installed');return next(specifier,context);}});\nconst { root } = await import(${JSON.stringify(pathToFileURL(join(sourceRoot, 'src', 'server', 'main.ts')).href)});\nif (root !== ${JSON.stringify(sourceRoot)}) throw new Error('Source entry resolved the wrong application root');\n`,
    );
    const child = fork(entry, [], {
      cwd: sourceRoot,
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      env: {
        ...process.env,
        COMBORUNNER_ROOT: '',
        AGENT_STUDIO_ROOT: '',
        COMBORUNNER_DATA_DIR: dataDir,
        COMBORUNNER_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((done) => child.once('exit', done));
    t.after(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        exited,
        new Promise<void>((done) => {
          timer = setTimeout(() => {
            child.kill();
            done();
          }, 5000);
        }),
      ]);
      clearTimeout(timer);
      cleanup(directory);
    });
    // A ready IPC message proves the server entry loads without any DSH dependency. Port zero is deliberate: no public fixed port is reused.
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${output}`)));
      child.on('message', (message) => {
        if ((message as { type?: string }).type === 'ready') done();
      });
    });
    child.send('shutdown');
    assert.equal(await exited, 0, output);
    const reopened = new Store(dataDir);
    try {
      const targets = reopened.config<RuntimeTarget[]>('targets', []);
      assert.equal(targets.find((target) => target.id === dsh.id)?.enabled, false);
      assert.equal(reopened.runSummaries().length, 0);
    } finally {
      reopened.close();
    }
    assert.ok(!readFileSync(join(sourceRoot, 'src', 'server', 'main.ts'), 'utf8').includes("from './dsh.ts'"));
  },
);

test('state broadcasts carry summaries of finished runs while the full record stays available by id', (t) => {
  const output = 'x'.repeat(10_000) + 'TAIL';
  const finished: RunRecord = {
    id: 'finished-run',
    prompt: 'task',
    projectPath: 'project',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: codex.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
    startedAt: new Date(epoch).toISOString(),
    endedAt: new Date(epoch).toISOString(),
    output,
    events: [{ type: 'status', at: new Date(epoch).toISOString(), text: 'done' }],
  };
  const { controller } = fixture(t, (store) => store.saveRun(finished));
  const listed = controller.state().runs.find((run) => run.id === finished.id)!;
  assert.equal(listed.summary, true);
  assert.deepEqual(listed.events, []);
  assert.ok(listed.output.length <= 4000);
  assert.ok(listed.output.endsWith('TAIL'));
  assert.deepEqual(controller.run(finished.id), finished);
  assert.equal(controller.run('missing-run'), undefined);
});

test('run records keep retired Jev route reasons in storage and omit them from the app', (t) => {
  // Older records saved this line for every pinned executor, whether or not Jev was set up.
  const reasons = ['已指定执行器或平台，跳过 Jev 远程筛选', '用户锁定执行器'];
  const saved: RunRecord = {
    id: 'jev-reasons-run',
    prompt: 'task',
    projectPath: 'project',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: codex.id, model: 'test-model', kind: 'general', reasons, warnings: [] },
    startedAt: new Date(epoch).toISOString(),
    endedAt: new Date(epoch).toISOString(),
    output: 'done',
    events: [
      {
        type: 'status',
        at: new Date(epoch).toISOString(),
        text: '路由指派',
        data: { source: 'pugport', kind: 'routing', detail: { runtimeId: codex.id, reasons } },
      },
    ],
  };
  const { controller } = fixture(t, (store) => store.saveRun(saved));
  const sent = () => [
    controller.state().runs.find((run) => run.id === saved.id)!,
    controller.shown(controller.runWithAudit(saved.id)!),
  ];
  for (const run of sent()) {
    assert.doesNotMatch(JSON.stringify(run), /Jev/);
    assert.deepEqual(run.route.reasons, ['用户锁定执行器']);
  }
  // The stored record keeps its original text.
  assert.deepEqual(controller.run(saved.id)!.route.reasons, reasons);
  const original = process.env.JEV_API_KEY;
  t.after(() => {
    if (original === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = original;
  });
  process.env.JEV_API_KEY = 'synthetic-test-key';
  controller.settings.taskJudgment = 'jev';
  for (const run of sent()) assert.doesNotMatch(JSON.stringify(run), /Jev/);
  controller.updateSettings({ taskJudgment: 'jev', memoryEvidence: 'jev' });
  assert.equal(controller.settings.taskJudgment, 'local');
  assert.equal(controller.settings.memoryEvidence, 'local');
  assert.deepEqual(controller.store.config('settings', {}), controller.settings);
});

test('direct Pi (environment API keys) stays off: disabled at start, cannot be enabled or pinned', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-core-test-'));
  const dataDir = join(directory, 'data');
  const stored = new Store(dataDir);
  stored.setConfig('targets', [{ ...codex }, { ...pi, enabled: true }]);
  stored.close();
  const controller = new Controller(directory, dataDir, { now: () => epoch });
  clearInterval(controller.timer);
  t.after(async () => {
    await controller.close();
    cleanup(directory);
  });
  assert.equal(controller.targets.find((target) => target.id === pi.id)?.enabled, false);
  assert.throws(() => controller.updateTarget(pi.id, { enabled: true }), /这个执行器已停用/);
  controller.snapshots = [observed(pi, epoch)];
  assert.throws(
    () =>
      controller.preview({
        prompt: 'must not invoke a model',
        projectPath: directory,
        kind: 'general',
        runtimeId: pi.id,
      }),
    /这个执行器已停用/,
  );
});

test('Inbox follows resource transitions and stays in AppState after reading until disabled', async (t) => {
  const { controller } = fixture(t, (store) => store.setConfig('targets', [{ ...codex }]));
  t.mock.method(controller, 'refresh', async () => {});
  controller.snapshots = [observed(codex, epoch)];
  controller.emit('resources-refreshed');
  assert.deepEqual(controller.state().inbox, { unread: 0, attention: 0, open: [] });
  controller.snapshots = [observed(codex, epoch, 'missing')];
  controller.broadcast();
  assert.equal(controller.state().inbox!.unread, 0, 'broadcast must not reconcile');
  controller.emit('resources-refreshed');
  const summary = controller.state().inbox!;
  assert.equal(summary.open[0]?.kind, 'executor-missing');
  assert.equal(summary.unread, 1);
  controller.inbox.markRead();
  assert.equal(controller.state().inbox!.unread, 0);
  assert.equal(controller.state().inbox!.attention, 1);
  controller.updateTarget(codex.id, { enabled: false });
  assert.equal(controller.state().inbox!.open.length, 0);
  controller.snapshots = [observed(codex, epoch, 'missing')];
  controller.emit('resources-refreshed');
  assert.equal(controller.state().inbox!.open.length, 0);
});

test('startup failure is recorded and presented without changing the machine code', async (t) => {
  const f = fixture(t);
  f.controller.snapshots = [observed(pi, f.now())];
  const startup = { exitCode: 1, elapsedMs: 25, firstLine: 'error: option invalid' };
  t.mock.method(piAdapter, 'execute', async () => {
    throw Object.assign(
      runtimeError(new Error('error: option invalid'), { provider: 'Pi', code: 'runtime-protocol-incompatible' }),
      { startup },
    );
  });
  const run: RunRecord = {
    id: 'startup-failure-fixture',
    prompt: 'synthetic',
    projectPath: f.directory,
    kind: 'general',
    status: 'running',
    route: { runtimeId: pi.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
    startedAt: new Date(epoch).toISOString(),
    output: '',
    events: [],
  };
  await f.controller.execute(
    run,
    { prompt: run.prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only' },
    pi,
    new AbortController(),
  );
  assert.equal(run.error, 'runtime-protocol-incompatible');
  assert.equal(run.errorCode, run.error);
  assert.equal(run.errorDetail, 'Pi: error: option invalid');
  assert.deepEqual(run.startupFailure, startup);
  assert.match(
    run.events.filter((event) => event.type === 'error').at(-1)?.text ?? '',
    /^Pi CLI 启动失败：error: option/,
  );
});

test('cooldown raises one executor-failing notice on the third counted failure', async (t) => {
  const f = fixture(t);
  f.controller.snapshots = [observed(codex, f.now())];
  t.mock.method(codexAdapter, 'execute', async () => {
    throw runtimeError(new Error('synthetic'), { code: 'runtime-process-closed' });
  });
  for (let i = 0; i < 3; i++) {
    f.advance(1000);
    const run: RunRecord = {
      id: `cooldown-${i}`,
      prompt: 'synthetic',
      projectPath: f.directory,
      kind: 'general',
      status: 'running',
      route: { runtimeId: codex.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
      startedAt: new Date(f.now()).toISOString(),
      output: '',
      events: [],
    };
    await f.controller.execute(
      run,
      { prompt: run.prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only' },
      codex,
      new AbortController(),
    );
    assert.equal(run.errorCode, 'runtime-process-closed');
  }
  const notices = f.controller.inbox.list().filter((n) => n.kind === 'executor-failing');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].key, codex.id);
  assert.equal(notices[0].count, 1);
  assert.deepEqual(notices[0].action, { kind: 'view-run', runId: 'cooldown-2' });
  assert.deepEqual(notices[0].source, { runtimeId: codex.id, label: codex.label, runId: 'cooldown-2' });
});

test('three startup protocol incompatibilities do not raise executor-failing', async (t) => {
  const f = fixture(t);
  f.controller.snapshots = [observed(codex, f.now())];
  t.mock.method(codexAdapter, 'execute', async () => {
    throw Object.assign(runtimeError(new Error('synthetic'), { code: 'runtime-protocol-incompatible' }), {
      startup: { exitCode: 1, elapsedMs: 10, firstLine: 'error: unknown option' },
    });
  });
  for (let i = 0; i < 3; i++) {
    f.advance(1_000);
    const run: RunRecord = {
      id: `incompatible-${i}`,
      prompt: 'synthetic',
      projectPath: f.directory,
      kind: 'general',
      status: 'running',
      route: { runtimeId: codex.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
      startedAt: new Date(f.now()).toISOString(),
      output: '',
      events: [],
    };
    await f.controller.execute(
      run,
      { prompt: run.prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only' },
      codex,
      new AbortController(),
    );
    assert.equal(run.errorCode, 'runtime-protocol-incompatible');
  }
  assert.equal(f.controller.cooldown.apply(observed(codex, f.now())).executorCooldown?.streak, 3);
  const notices = f.controller.inbox.list();
  assert.equal(notices.filter((notice) => notice.kind === 'executor-incompatible').length, 1);
  assert.equal(notices.filter((notice) => notice.kind === 'executor-failing').length, 0);
});

test('cooldown raises one global network notice and suppresses the third per-card notice', async (t) => {
  const f = fixture(t);
  f.controller.snapshots = [observed(codex, f.now()), observed(pi, f.now())];
  t.mock.method(codexAdapter, 'execute', async () => {
    throw runtimeError(new Error('synthetic'), { code: 'runtime-network-error' });
  });
  t.mock.method(piAdapter, 'execute', async () => {
    throw runtimeError(new Error('synthetic'), { code: 'runtime-timeout' });
  });
  for (const [i, target] of [codex, pi, codex, codex].entries()) {
    f.advance(1000);
    const run: RunRecord = {
      id: `network-${i}`,
      prompt: 'synthetic',
      projectPath: f.directory,
      kind: 'general',
      status: 'running',
      route: { runtimeId: target.id, model: 'test-model', kind: 'general', reasons: [], warnings: [] },
      startedAt: new Date(f.now()).toISOString(),
      output: '',
      events: [],
    };
    await f.controller.execute(
      run,
      { prompt: run.prompt, projectPath: f.directory, kind: 'general', permissionMode: 'read-only' },
      target,
      new AbortController(),
    );
    assert.equal(run.errorCode, target === codex ? 'runtime-network-error' : 'runtime-timeout');
  }
  const notices = f.controller.inbox.list();
  assert.equal(notices.filter((n) => n.kind === 'network' && n.key === 'global').length, 1);
  assert.equal(notices.filter((n) => n.kind === 'executor-failing').length, 0);
});
