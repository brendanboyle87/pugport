import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/server/controller.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { sandboxExecutions } from '../src/server/sandbox/execution.ts';
import { syntheticCodex } from './helpers/codex-rpc.ts';
import type { ExecuteContext, RunInput, RunRecord, RuntimeTarget } from '../src/shared/types.ts';

function fixture(t: TestContext, provider: RuntimeTarget['provider'] = 'codex') {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-ceiling-'));
  const home = join(directory, 'home');
  mkdirSync(home);
  const environment = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    PATH: '',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const controller = new Controller(directory, join(directory, 'data'), {
    readAccountIdentity: () => 'fixture',
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  const target: RuntimeTarget = {
    id: 'fixture',
    provider,
    label: 'Fixture',
    command: 'never-spawn',
    environment: 'native',
    enabled: true,
    accountFingerprint: 'fixture',
  };
  controller.targets = [target];
  controller.snapshots = [
    {
      ...target,
      installed: true,
      status: 'ready',
      models: [{ id: 'gpt-fixture', label: 'Fixture', efforts: ['low'] }],
      quota: { status: 'known', source: 'fixture', observedAt: new Date().toISOString(), windows: [] },
      capabilities: { execute: true, resume: true, cancel: true, approvals: true, toolless: true },
      refreshedAt: new Date().toISOString(),
    },
  ];
  const snapshot = controller.snapshots[0]!;
  const adapter = provider === 'codex' ? codexAdapter : provider === 'claude' ? claudeAdapter : piAdapter;
  t.mock.method(adapter, 'discover', async () => snapshot);
  controller.settings.allowDirectPiApi = true;
  const paths = ['git-dir', 'objects', 'refs', 'logs'].map((name) => join(directory, name));
  let calls = 0;
  controller.gitWritePathsFor = async () => {
    calls++;
    return { paths };
  };
  const requests: Record<string, unknown>[] = [];
  const inputs: RunInput[] = [];
  const trustedProjects: Array<boolean | undefined> = [];
  const synthetic = syntheticCodex({}, requests);
  t.mock.method(
    provider === 'codex' ? codexAdapter : provider === 'claude' ? claudeAdapter : piAdapter,
    'execute',
    async (ctx: ExecuteContext) => {
      inputs.push(ctx.input);
      trustedProjects.push(ctx.trustedProject);
      return provider === 'codex' ? synthetic.execute(ctx) : { output: 'Synthetic answer' };
    },
  );
  t.after(async () => {
    await controller.close();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  let count = 0;
  async function execute(overrides: Partial<RunInput> = {}, parentRunId?: string) {
    const run: RunRecord = {
      id: `run-${++count}`,
      prompt: 'Synthetic task',
      projectPath: directory,
      kind: 'general',
      status: 'running',
      route: { runtimeId: target.id, model: 'gpt-fixture', kind: 'general', reasons: [], warnings: [] },
      startedAt: new Date().toISOString(),
      output: '',
      events: [],
      parentRunId,
      toolApprovalMode: overrides.toolApprovalMode ?? 'auto',
    };
    const input: RunInput = {
      prompt: run.prompt,
      projectPath: directory,
      kind: 'general',
      permissionMode: 'workspace-write',
      ...overrides,
    };
    const abort = new AbortController();
    controller.active.set(run.id, { run, abort, project: directory, permissionMode: input.permissionMode });
    controller.store.saveRun(run);
    await controller.execute(run, input, target, abort);
    assert.equal(run.status, 'completed', run.error ?? 'synthetic run should complete');
    return run;
  }
  return { controller, execute, paths, requests, inputs, trustedProjects, calls: () => calls };
}

test('controller passes managed source trust to Pi', async (t) => {
  const f = fixture(t, 'pi');
  f.controller.isTrustedProjectPath = () => false;
  f.controller.managedExecutionWorkspace = (input) => ({
    directory: input.projectPath,
    repositoryCommonDirectory: input.projectPath,
    sourceTrusted: true,
  });
  const run = await f.execute({ workflowId: 'managed' });
  assert.equal(f.trustedProjects.at(-1), true);
  assert.match(run.events.find((event) => event.data?.kind === 'permission-ceiling')!.text!, /Git 提交 完全访问/);
});

test('controller host Git paths reach Codex turn policies and narrowing removes them', async (t) => {
  const f = fixture(t);
  for (const scenario of [
    { input: {}, trusted: false, allowed: true },
    { input: { permissionMode: 'read-only' }, trusted: false, allowed: false },
    { input: { untrustedContent: true }, trusted: false, allowed: false },
    { input: { backgroundTrigger: { kind: 'peer', id: 'fixture' } }, trusted: false, allowed: false },
    { input: {}, trusted: true, allowed: false },
  ] as Array<{ input: Partial<RunInput>; trusted: boolean; allowed: boolean }>) {
    f.controller.isTrustedProjectPath = () => scenario.trusted;
    const before = f.calls();
    await f.execute(scenario.input);
    assert.equal(f.calls() - before, scenario.allowed ? 1 : 0);
    const turn = f.requests.filter((r) => r.method === 'turn/start').at(-1)!;
    const policy = (turn.params as { sandboxPolicy: { writableRoots?: string[] } }).sandboxPolicy;
    for (const path of f.paths) assert.equal(policy.writableRoots?.includes(path) ?? false, scenario.allowed);
    assert.deepEqual(f.inputs.at(-1)!.gitWritePaths, scenario.allowed ? f.paths : undefined);
  }
});

test('controller follows managed source trust for Codex and preserves narrowing', async (t) => {
  const f = fixture(t);
  f.controller.isTrustedProjectPath = () => false;
  f.controller.managedExecutionWorkspace = (input) =>
    input.workflowId === 'managed'
      ? { directory: input.projectPath, repositoryCommonDirectory: input.projectPath, sourceTrusted: true }
      : undefined;
  for (const [overrides, full] of [
    [{ workflowId: 'managed' }, true],
    [{ workflowId: 'managed', webDriven: true }, false],
    [{ workflowId: 'managed', untrustedContent: true }, false],
    [{ workflowId: 'managed', prohibitCommands: true }, false],
    [{ workflowId: 'managed', textOnly: true }, false],
    [{ workflowId: 'managed', permissionMode: 'read-only' }, false],
    [{ workflowId: 'unknown' }, false],
  ] as Array<[Partial<RunInput>, boolean]>) {
    await f.execute(overrides);
    const turn = f.requests.filter((item) => item.method === 'turn/start').at(-1)!;
    assert.equal((turn.params as { sandboxPolicy: { type: string } }).sandboxPolicy.type === 'dangerFullAccess', full);
  }
});

test('controller discards request network and Git paths and recomputes after read-only continuation', async (t) => {
  const f = fixture(t);
  await f.execute({ network: false, gitWritePaths: ['request-injection'] });
  assert.equal(f.inputs.at(-1)!.network, true);
  assert.deepEqual(f.inputs.at(-1)!.gitWritePaths, f.paths);
  await f.execute({ permissionMode: 'read-only', network: true, gitWritePaths: ['request-injection'] });
  assert.equal(f.inputs.at(-1)!.network, false);
  assert.equal(f.inputs.at(-1)!.gitWritePaths, undefined);
  const policies = f.requests
    .filter((r) => r.method === 'turn/start')
    .map((r) => (r.params as { sandboxPolicy: { networkAccess: boolean } }).sandboxPolicy);
  assert.deepEqual(
    policies.map((p) => p.networkAccess),
    [true, false],
  );
});

for (const scenario of [
  { name: 'controlled Codex', provider: 'codex', text: '权限上限：写入 开 · 网络 开 · Git 提交 本工作树' },
  {
    name: 'unsandboxed Claude',
    provider: 'claude',
    text: '权限上限：写入 开 · 网络 开 · Git 提交 开（该执行器没有沙箱，不受 PugPort 控制）',
  },
  {
    name: 'Pi',
    provider: 'pi',
    text: '权限上限：写入 开 · 网络 关 · Git 提交 关（Pi 自动模式不运行命令，不能提交或联网）',
  },
  {
    name: 'main checkout',
    provider: 'codex',
    text: '权限上限：写入 开 · 网络 开 · Git 提交 关（主检出：直接提交需要放开整个 .git，含 config 和 hooks；请用工作线，或由派单方提交）',
  },
  {
    name: 'full access',
    provider: 'codex',
    text: '权限上限：写入 开 · 网络 完全访问 · Git 提交 完全访问（该执行器没有沙箱，不受 PugPort 控制）',
  },
] as const)
  test(`controller emits exactly one permission ceiling for ${scenario.name}`, async (t) => {
    const f = fixture(t, scenario.provider);
    if (scenario.name === 'main checkout')
      f.controller.gitWritePathsFor = async () => ({ paths: [], mainCheckout: true });
    if (scenario.name === 'full access') f.controller.isTrustedProjectPath = () => true;
    for (let index = 0; index < 2; index++) {
      const run = await f.execute();
      assert.deepEqual(
        run.events.filter((event) => event.data?.kind === 'permission-ceiling').map((event) => event.text),
        [scenario.text],
      );
    }
  });

test('controller never derives network from a previous native session or stores it on a run', async (t) => {
  const f = fixture(t);
  const previous = await f.execute();
  await f.execute({ permissionOrigin: { source: 'parent', mode: 'workspace-write' } }, previous.id);
  assert.equal(f.inputs.at(-1)!.network, false);
  assert.equal('network' in f.controller.store.storedRun(previous.id)!, false);
});

for (const approval of ['auto', 'ask'] as const)
  test(`controller Pi ${approval} never probes Git and reports its actual command mode`, async (t) => {
    const f = fixture(t, 'pi');
    f.controller.settings.sandbox = { pi: 'learn' };
    t.mock.method(sandboxExecutions, 'prepare', () => undefined);
    const run = await f.execute({ toolApprovalMode: approval });
    assert.equal(f.calls(), 0);
    assert.equal(f.inputs.at(-1)!.gitWritePaths, undefined);
    const line = run.events.find((event) => event.data?.kind === 'permission-ceiling')!.text!;
    assert.equal(
      line,
      approval === 'auto'
        ? '权限上限：写入 开 · 网络 关 · Git 提交 关（Pi 自动模式不运行命令，不能提交或联网）'
        : '权限上限：写入 开 · 网络 开 · Git 提交 开（该执行器没有沙箱，不受 PugPort 控制）',
    );
  });

test('controller probes Git for Codex or learn mode only; unsandboxed writes stay on even in a main checkout', async (t) => {
  const f = fixture(t, 'claude');
  let calls = 0;
  f.controller.gitWritePathsFor = async () => {
    calls++;
    return { paths: [], mainCheckout: true };
  };
  const write = await f.execute();
  assert.equal(calls, 0);
  assert.match(
    write.events.find((event) => event.data?.kind === 'permission-ceiling')!.text!,
    /Git 提交 开（该执行器没有沙箱/,
  );
  const read = await f.execute({ permissionMode: 'read-only' });
  assert.equal(calls, 0);
  assert.match(
    read.events.find((event) => event.data?.kind === 'permission-ceiling')!.text!,
    /Git 提交 关（该执行器没有沙箱/,
  );
  f.controller.settings.sandbox = { claude: 'learn' };
  t.mock.method(sandboxExecutions, 'prepare', () => undefined);
  await f.execute();
  assert.equal(calls, 1);
});
