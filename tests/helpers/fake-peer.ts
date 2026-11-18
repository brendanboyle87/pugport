import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { TestContext } from 'node:test';
import { FailureLimiter, PeerRegistry } from '../../src/server/node/peer-auth.ts';
import { PeerListener } from '../../src/server/node/peer-listener.ts';
import { projectFolderCheck } from '../../src/server/node/device-node.ts';
import { settledStatuses, type PeerRuntimes, type SlackHostRequest } from '../../src/server/node/peer-protocol.ts';
import { peerApp, type PeerApiOptions } from '../../src/server/node/peer-routes.ts';
import { PeerRequestNotSent, type PeerDispatch, type PeerTaskRunner } from '../../src/server/node/peer-tasks.ts';
import { fetchPortAllowed } from './fetch-port.ts';

/** A temporary folder that is removed after the test (and checked to be one before removal). */
export function temporaryFolder(t: TestContext, prefix: string) {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    const absolute = resolve(folder);
    if (!absolute.startsWith(realpathSync.native(tmpdir()) + sep) || !basename(absolute).startsWith(prefix))
      throw new Error('refusing to remove an unexpected folder');
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return folder;
}

type FakeTask = { peerId: string; input: PeerDispatch; status: string; result?: string; error?: string };

/** A node's task service that answers what it is told to (no executors): tests finish tasks themselves. */
export function fakeRunner() {
  const tasks = new Map<string, FakeTask>();
  const cancelled = new Set<string>();
  const waiters = new Set<() => void>();
  let count = 0;
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const runner: PeerTaskRunner = {
    async cancelRequest(requestId, peerId) {
      cancelled.add(`${peerId}:${requestId}`);
      return runner.lookup(requestId, peerId);
    },
    async lookup(requestId, peerId) {
      return [...tasks].find(([, task]) => task.peerId === peerId && task.input.requestId === requestId)?.[0];
    },
    async dispatch(input, peerId) {
      const prior = input.requestId && (await runner.lookup(input.requestId, peerId));
      if (prior) return { taskId: prior, status: tasks.get(prior)!.status };
      if (input.requestId && cancelled.has(`${peerId}:${input.requestId}`))
        throw new PeerRequestNotSent('这条请求已经取消，没有启动任务。');
      const taskId = `task-${++count}`;
      tasks.set(taskId, { peerId, input, status: 'running' });
      return { taskId, status: 'queued' };
    },
    owner: (taskId) => tasks.get(taskId)?.peerId,
    status(taskId) {
      const task = tasks.get(taskId);
      return task && { taskId, status: task.status, executor: 'Claude 测试号', model: 'fake-model' };
    },
    async result(taskId, waitSeconds, signal) {
      const task = tasks.get(taskId);
      if (!task) return undefined;
      if (!settledStatuses.has(task.status) && waitSeconds > 0)
        await new Promise<void>((done) => {
          const finish = () => {
            clearTimeout(timer);
            waiters.delete(finish);
            done();
          };
          const timer = setTimeout(finish, waitSeconds * 1000);
          waiters.add(finish);
          signal?.addEventListener('abort', finish, { once: true });
        });
      if (!settledStatuses.has(task.status)) return { status: task.status };
      return task.status === 'completed'
        ? { status: task.status, result: task.result ?? '' }
        : { status: task.status, error: task.error ?? '' };
    },
    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return false;
      if (!settledStatuses.has(task.status)) task.status = 'cancelled';
      wake();
      return true;
    },
  };
  return {
    runner,
    tasks,
    finish(taskId: string, result: string) {
      const task = tasks.get(taskId)!;
      task.status = 'completed';
      task.result = result;
      wake();
    },
    fail(taskId: string, error: string) {
      const task = tasks.get(taskId)!;
      task.status = 'blocked';
      task.error = error;
      wake();
    },
  };
}

export const fakeRuntimes: PeerRuntimes = {
  executors: [
    {
      label: 'Claude 测试号',
      provider: 'claude',
      status: 'ready',
      windows: [
        { name: '5h', remaining: 80 },
        { name: '周', remaining: 62 },
      ],
      tightest: 62,
      observedAt: '2026-10-11T08:00:00.000Z',
    },
  ],
  running: 0,
};

/** A device node's peer API on 127.0.0.1 with a fake task service and a peer record in a temporary folder. */
export async function startPeer(
  t: TestContext,
  options: Partial<Omit<PeerApiOptions, 'registry' | 'runner'>> & {
    folder?: string;
    host?: string;
  } = {},
) {
  const { folder: given, host, ...api } = options;
  const folder = given ?? temporaryFolder(t, 'fake-peer-test-');
  const registry = new PeerRegistry(join(folder, 'peers.json'), { helperTimeoutMs: 15_000 });
  await registry.load();
  const fake = fakeRunner();
  const logs: string[] = [];
  const slackCalls: SlackHostRequest[] = [];
  let slackHost = false;
  let githubHost = false;
  const app = peerApp({
    registry,
    runner: fake.runner,
    info: () => ({
      name: 'PugPort',
      version: '0.0.0-test',
      role: 'node',
      hostname: 'ubuntu-box',
      platform: 'linux',
      arch: 'x64',
      capabilities: { trash: true, accountLogin: false, gpu: true, shortcuts: false },
      slackHost,
      githubHost,
      allowWrite: api.allowWrite ?? true,
    }),
    runtimes: () => fakeRuntimes,
    slack: async (request) => {
      slackCalls.push(request);
      slackHost = request.host;
      return { slackHost };
    },
    limiter: new FailureLimiter(),
    log: (line) => logs.push(line),
    eventPollMs: 20,
    projectFolder: projectFolderCheck(),
    ...api,
  });
  for (;;) {
    const listener = await new Promise<PeerListener>((done, fail) => {
      const listener = new PeerListener({
        handler: app,
        port: 0,
        host: host ?? '127.0.0.1',
        log: () => {
          const state = listener.state();
          if (state.status === 'listening') done(listener);
          if (state.status === 'error') fail(new Error(`fake peer failed to listen: ${state.error}`));
        },
      });
      t.after(() => listener.close());
      listener.start();
    });
    const port = listener.boundPort()!;
    if (!fetchPortAllowed(port)) {
      await listener.close();
      continue;
    }
    return {
      ...fake,
      registry,
      listener,
      logs,
      slackCalls,
      port,
      address: `127.0.0.1:${port}`,
      url: `http://127.0.0.1:${port}`,
      setSlackHost: (value: boolean) => (slackHost = value),
      setGitHubHost: (value: boolean) => (githubHost = value),
    };
  }
}
