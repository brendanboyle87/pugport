import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { branchPublishAvailable } from '../src/server/branch-publish.ts';
import { extensions } from '../src/server/extensions.ts';
import { hostGit } from '../src/server/managed-worktrees.ts';
import type { ConnectorService } from '../src/server/connectors.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';

const publishNames = ['push_branch', 'open_branch_pull_request', 'merge_branch_pull_request'];

test('publish tools exist only for a writable networked foreground run', () => {
  assert.equal(branchPublishAvailable({ write: true, network: true }), true);
  for (const caller of [
    { write: false, network: true },
    { write: true, network: false },
    { write: true, network: true, child: true },
    { write: true, network: true, background: true },
    { write: true, network: true, prohibitCommands: true },
  ])
    assert.equal(branchPublishAvailable(caller), false);
});

test('the bridge lists publish tools only when the host allows them, and a direct call says why', async (t) => {
  t.mock.method(extensions, 'bridgeTools', () => []);
  const cases = [
    { name: 'write and network', caller: { write: true, network: true }, listed: true },
    { name: 'read-only', caller: { write: false, network: true }, listed: false },
    { name: 'network off', caller: { write: true, network: false }, listed: false },
    { name: 'child', caller: { write: true, network: true, child: true }, listed: false },
    { name: 'background', caller: { write: true, network: true, background: true }, listed: false },
    { name: 'prohibit commands', caller: { write: true, network: true, prohibitCommands: true }, listed: false },
  ];
  const detached = await detachedCheckout(t);
  for (const item of cases) {
    const bridge = bridgeFor(t, item.caller, item.listed ? detached : t.name);
    const listed = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    for (const name of publishNames) assert.equal(names.includes(name), item.listed, item.name);
    const called = await bridge.handle('Bearer synthetic', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'push_branch', arguments: {} },
    });
    const body = called.body as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    const message = body.error?.message ?? body.result?.content?.[0]?.text ?? '';
    assert.equal(body.result?.isError ?? !item.listed, true, message);
    if (item.listed) assert.match(message, /不在具名分支/);
    else if (item.caller.prohibitCommands) assert.match(message, /本轮禁止执行命令/);
    else assert.match(message, /只在可写且允许联网的前台任务中提供/);
    await bridge.close();
  }
  const closed = bridgeFor(t, { write: true, network: true });
  assert.deepEqual(await closed.handle(undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    status: 401,
    body: { error: '执行器令牌无效或任务已结束。' },
  });
  await closed.close();
});

const envNames = ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP'] as const;

/** The repo sits beside a private temp dir, so the publish temp-dir refusal does not fire. */
async function detachedCheckout(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pp-gate-')));
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const checkout = join(root, 'repo');
  await mkdir(home);
  await mkdir(temp);
  // The test harness keeps one per-process directory under the first temp dir it sees; create it before the swap.
  await hostGit(root, ['--version']);
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TMPDIR: temp, TEMP: temp, TMP: temp });
  t.after(async () => {
    for (const name of envNames)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    await rm(root, { recursive: true, force: true });
  });
  await hostGit(root, ['init', '-b', 'feature', checkout]);
  await hostGit(checkout, ['commit', '--allow-empty', '-m', 'one']);
  await hostGit(checkout, ['checkout', '--detach']);
  return checkout;
}

function bridgeFor(t: TestContext, extra: Record<string, unknown>, projectPath = t.name) {
  const controller = Object.assign(new EventEmitter(), {
    dataDir: join(tmpdir(), 'pugport-bridge-gate-missing'),
    agentBridgeCaller: () => ({
      run: { id: 'synthetic-run', projectPath },
      target: { provider: 'codex', label: 'Synthetic' },
      delegate: false,
      recycle: false,
      child: false,
      signal: new AbortController().signal,
      ...extra,
    }),
    returnExecution: () => async () => {},
    recordRunEvent: () => {},
  }) as unknown as Controller;
  const workspace = { store: { get: () => undefined } } as unknown as Workspace;
  return new AgentBridge(workspace, controller, 'unused', {}, {
    toolsFor: async () => [],
  } as unknown as ConnectorService);
}
