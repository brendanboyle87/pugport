import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { codexPermissionConfig, codexAppServerArgs, codexWindowsSandbox } from '../src/server/adapters/codex.ts';
import type { SandboxStatus } from '../src/shared/sandbox.ts';
import { syntheticCodex } from './helpers/codex-rpc.ts';
import type { ExecuteContext, RunEvent } from '../src/shared/types.ts';

function context(permissionMode: 'read-only' | 'workspace-write') {
  const events: RunEvent[] = [];
  const ctx: ExecuteContext = {
    target: {
      id: 'fixture',
      provider: 'codex',
      label: 'Synthetic Codex',
      command: 'never-spawned',
      environment: 'native',
      enabled: true,
    },
    input: {
      prompt: 'Private prompt must not enter permission trace',
      projectPath: process.cwd(),
      kind: 'general',
      permissionMode,
    },
    route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    approvalMode: 'auto',
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    approve: async () => assert.fail('Automatic permission trace must not prompt'),
  };
  return { ctx, events };
}

test('Codex selects MXC only for an available base container with deny paths, and records the actual backend', async () => {
  for (const status of [
    { available: true, reason: 'ready', message: '可用 · 进程容器', tier: 'base-container', denyPathsSupported: true },
    { available: false, reason: 'build', message: '系统未更新', tier: 'base-container', denyPathsSupported: true },
    { available: true, reason: 'tier', message: '降级不可用', tier: 'appcontainer-dacl', denyPathsSupported: true },
    { available: true, reason: 'tier', message: '缺少路径拒绝', tier: 'base-container', denyPathsSupported: false },
  ] satisfies SandboxStatus[]) {
    const expected =
      status.available && status.tier === 'base-container' && status.denyPathsSupported ? 'mxc' : 'elevated';
    const { ctx, events } = context('read-only');
    assert.equal(codexWindowsSandbox(status), expected);
    const args = codexAppServerArgs(ctx.target, 'win32', undefined, status);
    assert.ok(args.includes(`windows.sandbox='${expected}'`));
    assert.ok(!args.some((arg) => /unelevated|danger-full-access/.test(arg)));
    assert.ok(
      !codexAppServerArgs({ ...ctx.target, environment: 'wsl' }, 'win32', undefined, status).some((arg) =>
        arg.includes('windows.sandbox'),
      ),
    );
    await syntheticCodex({
      sandboxStatus: status,
      onLaunch: (actual) => {
        if (process.platform === 'win32') assert.ok(actual.includes(`windows.sandbox='${expected}'`));
      },
    }).execute(ctx);
    const trace = events.filter((event) => event.data?.kind === 'permission-config');
    assert.equal(trace.length, 2);
    if (process.platform === 'win32')
      for (const event of trace) {
        const detail = event.data!.detail as Record<string, unknown>;
        assert.equal(detail.windowsSandbox, expected);
        assert.equal(detail.sandboxStatus, status.message);
      }
  }
});

for (const mode of ['read-only', 'workspace-write'] as const) {
  test(`Codex ${mode} permission trace matches actual RPC dispatch and does not claim absent native echoes`, async () => {
    const { ctx, events } = context(mode);
    const requests: Record<string, unknown>[] = [];
    await syntheticCodex({}, requests).execute(ctx);
    const configuration = events.filter((event) => event.data?.kind === 'permission-config');
    assert.equal(configuration.length, 2);
    for (const event of configuration) {
      const detail = event.data!.detail as Record<string, unknown>;
      assert.equal(detail.provenance, 'requested');
      const dispatch = requests.find((request) => request.method === detail.method)!;
      const params = dispatch.params as Record<string, unknown>;
      for (const [field, value] of Object.entries(codexPermissionConfig(params)))
        assert.deepEqual(detail[field], value);
      assert.equal(detail.runtimeId, ctx.target.id);
      assert.equal(detail.approvalPolicy, 'never');
      assert.equal(detail.approvalsReviewer, 'user');
      assert.ok(!JSON.stringify(detail).includes(ctx.input.prompt));
    }
    const turn = configuration.find(
      (event) => (event.data!.detail as Record<string, unknown>).method === 'turn/start',
    )!;
    const policy = (turn.data!.detail as Record<string, unknown>).sandboxPolicy as Record<string, unknown>;
    assert.equal(policy.networkAccess, false);
    assert.equal(policy.type, mode === 'workspace-write' ? 'workspaceWrite' : 'readOnly');
    if (mode === 'workspace-write') {
      const roots = policy.writableRoots as string[];
      assert.equal(roots.length, 2);
      assert.equal(roots[0], process.cwd());
      assert.match(basename(roots[1]!), /^pugport-codex-/);
      assert.equal(existsSync(roots[1]!), false, 'temporary files are cleaned after the executor exits');
      assert.equal(policy.excludeTmpdirEnvVar, true);
      assert.equal(policy.excludeSlashTmp, true);
    } else assert.equal(policy.writableRoots, undefined);
  });
}

test('trusted writable Codex starts and resumes with full access; other policies remain unchanged', async () => {
  for (const resume of [false, true]) {
    for (const scenario of [
      { trusted: true, mode: 'workspace-write', full: true },
      // A local caller's writable task in a trusted project runs as if typed in the app.
      {
        trusted: true,
        mode: 'workspace-write',
        full: true,
        origin: { mode: 'workspace-write', source: 'caller', unrestricted: false },
      },
      {
        trusted: true,
        mode: 'workspace-write',
        full: true,
        origin: { mode: 'workspace-write', source: 'caller', unrestricted: true },
      },
      { trusted: true, mode: 'workspace-write', full: true, origin: { mode: 'workspace-write', source: 'caller' } },
      { trusted: false, mode: 'workspace-write', full: false, origin: { mode: 'workspace-write', source: 'caller' } },
      { trusted: true, mode: 'read-only', full: false },
      { trusted: false, mode: 'workspace-write', full: false },
      { trusted: true, mode: 'read-only', untrusted: true, full: false },
      { trusted: true, mode: 'workspace-write', untrusted: true, full: false },
      { trusted: true, mode: 'read-only', textOnly: true, full: false },
      { trusted: true, mode: 'workspace-write', textOnly: true, full: false },
      // A turn acting on search results keeps Codex's own sandbox, even in a trusted project.
      { trusted: true, mode: 'workspace-write', webDriven: true, full: false },
      // "Do not run commands" was still given full access before; a scheduled wake-up keeps it.
      { trusted: true, mode: 'workspace-write', prohibitCommands: true, full: false },
      { trusted: true, mode: 'workspace-write', background: true, full: true },
    ] as const) {
      const { ctx, events } = context(scenario.mode);
      ctx.trustedProject = scenario.trusted;
      if ('origin' in scenario) ctx.input.permissionOrigin = scenario.origin;
      ctx.input.untrustedContent = 'untrusted' in scenario;
      ctx.input.textOnly = 'textOnly' in scenario;
      ctx.input.webDriven = 'webDriven' in scenario;
      ctx.input.prohibitCommands = 'prohibitCommands' in scenario;
      if ('background' in scenario) ctx.input.backgroundTrigger = { kind: 'schedule', id: 'synthetic' };
      if (resume) ctx.nativeSessionId = 'previous-thread';
      const requests: Record<string, unknown>[] = [];
      await syntheticCodex({}, requests).execute(ctx);
      const thread = requests.find((r) => r.method === (resume ? 'thread/resume' : 'thread/start'))!.params as Record<
        string,
        unknown
      >;
      const turn = requests.find((r) => r.method === 'turn/start')!.params as Record<string, unknown>;
      assert.equal(thread.sandbox, scenario.full ? 'danger-full-access' : scenario.mode);
      assert.equal(turn.approvalPolicy, 'never');
      if (scenario.full) {
        // This protocol variant has no networkAccess field: full access includes unrestricted network.
        assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' });
      } else {
        const policy = turn.sandboxPolicy as Record<string, unknown>;
        assert.equal(policy.type, scenario.mode === 'read-only' ? 'readOnly' : 'workspaceWrite');
        assert.equal(policy.networkAccess, false);
      }
      assert.equal(events.filter((e) => e.text === '信任项目：本次不使用沙箱').length, scenario.full ? 1 : 0);
    }
  }
});

test('native permission echo projection admits only reported public fields and redacts roots', () => {
  assert.deepEqual(codexPermissionConfig({ thread: { id: 'thread' }, token: 'SECRET', prompt: 'PRIVATE' }), {});
  const observed = codexPermissionConfig({
    approvalPolicy: 'never',
    sandboxPolicy: {
      type: 'workspaceWrite',
      networkAccess: false,
      writableRoots: ['C:/fixture', 'token=SECRET_ROOT'],
      privateToken: 'SECRET_POLICY',
      excludeSlashTmp: true,
    },
    privateConfig: { authorization: 'SECRET_CONFIG' },
    headers: { Authorization: 'SECRET_HEADER' },
  });
  assert.equal(observed.approvalPolicy, 'never');
  assert.equal(observed.cwd, undefined);
  const policy = observed.sandboxPolicy as Record<string, unknown>;
  assert.equal(policy.networkAccess, false);
  assert.deepEqual((policy.writableRoots as string[])[0], 'C:/fixture');
  assert.ok(!JSON.stringify(observed).includes('SECRET'));
  assert.equal(policy.excludeTmpdirEnvVar, undefined);
  assert.deepEqual(
    codexPermissionConfig({ sandbox: { type: 'readOnly', networkAccess: false }, privateToken: 'SECRET' }),
    {
      sandbox: { type: 'readOnly', networkAccess: false },
    },
  );
});

test('Codex turn policy follows the host-decided network and Git paths only when it may write', async () => {
  const gitWritePaths = ['C:/synthetic/.git/worktrees/lane', 'C:/synthetic/.git/objects'];
  for (const scenario of [
    { mode: 'workspace-write', network: true, git: gitWritePaths, trusted: false },
    { mode: 'workspace-write', network: false, git: undefined, trusted: false },
    { mode: 'read-only', network: true, git: gitWritePaths, trusted: false },
    { mode: 'workspace-write', network: true, git: gitWritePaths, trusted: true },
  ] as const) {
    const { ctx } = context(scenario.mode);
    ctx.trustedProject = scenario.trusted;
    ctx.input.network = scenario.network;
    if (scenario.git) ctx.input.gitWritePaths = [...scenario.git];
    const requests: Record<string, unknown>[] = [];
    await syntheticCodex({}, requests).execute(ctx);
    const turn = requests.find((request) => request.method === 'turn/start')!;
    const policy = (turn.params as Record<string, unknown>).sandboxPolicy as Record<string, unknown>;
    if (scenario.trusted) {
      assert.deepEqual(policy, { type: 'dangerFullAccess' });
    } else if (scenario.mode === 'read-only') {
      assert.deepEqual(policy, { type: 'readOnly', networkAccess: false });
    } else {
      assert.equal(policy.networkAccess, scenario.network);
      const roots = policy.writableRoots as string[];
      assert.deepEqual(roots.slice(1, 1 + (scenario.git?.length ?? 0)), scenario.git ?? []);
      assert.equal(roots[0], process.cwd());
      assert.match(basename(roots.at(-1)!), /^pugport-codex-/);
    }
  }
});
