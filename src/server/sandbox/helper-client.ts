import { fork, type ChildProcess } from '../platform/test-process.ts';
import { fileURLToPath } from 'node:url';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import type { MxcDriver } from './mxc-child.ts';
import type { HelperProbe, HelperReply, HelperRequest } from './helper-protocol.ts';

const helpers = new Set<ChildProcess>();
let shuttingDown = false;

export function isMxcHelperPid(pid: number) {
  return [...helpers].some((child) => child.pid === pid);
}

function launchHelper(): ChildProcess {
  if (shuttingDown) throw new Error('operation-cancelled');
  const source = import.meta.url.endsWith('.ts');
  const entry = new URL(source ? './helper-entry.ts' : './mxc-helper.js', import.meta.url);
  return fork(fileURLToPath(entry), [], {
    execPath: process.execPath,
    execArgv: source ? ['--import', 'tsx'] : [],
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    serialization: 'json',
  });
}

function error(code: string, nativeCode?: string) {
  return Object.assign(new Error('runtime-permission-or-sandbox-error'), {
    code,
    ...(nativeCode ? { nativeCode } : {}),
  });
}

function open(request: HelperRequest, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('operation-cancelled');
  const child = mxcHelpers.launch();
  helpers.add(child);
  child.once('close', () => helpers.delete(child));
  child.stdin?.on('error', () => {});
  let ready!: (value: HelperReply) => void;
  let rejectReady!: (error: Error) => void;
  const startup = new Promise<HelperReply>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  void startup.catch(() => {});
  let complete!: (value: Extract<HelperReply, { type: 'done' | 'probe' }>) => void;
  let rejectComplete!: (error: Error) => void;
  const terminal = new Promise<Extract<HelperReply, { type: 'done' | 'probe' }>>((resolve, reject) => {
    complete = resolve;
    rejectComplete = reject;
  });
  // A crash before consumers receive the driver must not create an unhandled rejection.
  void terminal.catch(() => {});
  let result: Extract<HelperReply, { type: 'done' | 'probe' }> | undefined;
  let failure: Error | undefined;
  let started = false;
  const fail = (reason: Error) => {
    failure ??= reason;
    rejectReady(failure);
    rejectComplete(failure);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const startupTimer = setTimeout(() => {
    fail(error('sandbox-helper-timeout'));
    child.kill('SIGKILL');
  }, 15000);
  const cancelled = () => fail(Object.assign(new Error('operation-cancelled'), { code: 'operation-cancelled' }));
  signal?.addEventListener('abort', cancelled, { once: true });
  child.on('message', (value: unknown) => {
    if (!value || typeof value !== 'object') return fail(error('sandbox-helper-protocol'));
    const message = value as HelperReply;
    if (
      message.type === 'ready' &&
      request.type === 'spawn' &&
      Number.isInteger(message.pid) &&
      message.pid > 0 &&
      !started
    ) {
      started = true;
      clearTimeout(startupTimer);
      ready(message);
    } else if (message.type === 'probe' && request.type === 'probe') {
      result = message;
    } else if (
      message.type === 'done' &&
      started &&
      Number.isInteger(message.exitCode) &&
      typeof message.timedOut === 'boolean'
    ) {
      result = message;
    } else if (message.type === 'error') {
      fail(error(message.code, message.nativeCode));
    } else fail(error('sandbox-helper-protocol'));
  });
  child.once('error', () => fail(error('sandbox-helper-spawn')));
  child.once('close', (code, signal) => {
    // The run signal belongs only to this helper lifetime.
    runSignal?.removeEventListener('abort', cancelled);
    clearTimeout(startupTimer);
    if (failure) return;
    if (code !== 0 || signal || !result) {
      const nativeCode =
        code !== null && code >>> 0 >= 0x80000000 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : undefined;
      fail(error('sandbox-helper-crashed', nativeCode));
    } else {
      ready(result);
      complete(result);
    }
  });
  const runSignal = signal;
  if (signal?.aborted) cancelled();
  try {
    child.send(request, (sendError) => {
      if (sendError) fail(error('sandbox-helper-protocol'));
    });
  } catch {
    fail(error('sandbox-helper-protocol'));
  }
  return { child, startup, terminal };
}

export async function probeMxcHelper(): Promise<HelperProbe> {
  const session = open({ type: 'probe' });
  session.child.stdout?.resume();
  session.child.stderr?.resume();
  session.child.stdin?.end();
  const reply = await session.terminal;
  if (reply.type !== 'probe') throw error('sandbox-helper-protocol');
  return reply.result;
}

export async function spawnMxcHelper(request: ContainerRequest, signal?: AbortSignal): Promise<MxcDriver> {
  const session = open({ type: 'spawn', request }, signal);
  let reply: HelperReply;
  try {
    reply = await session.startup;
  } catch (error) {
    session.child.stdout?.resume();
    session.child.stderr?.resume();
    session.child.stdin?.destroy();
    throw error;
  }
  if (reply.type !== 'ready' || !session.child.stdin || !session.child.stdout || !session.child.stderr)
    throw error('sandbox-helper-protocol');
  let metadata: MxcDriver['outputMetadata'];
  return {
    id: reply.pid,
    standardInput: session.child.stdin,
    standardOutput: session.child.stdout,
    standardError: session.child.stderr,
    get outputMetadata() {
      return metadata;
    },
    async wait() {
      const result = await session.terminal;
      if (result.type !== 'done') throw error('sandbox-helper-protocol');
      metadata = result.metadata;
      return { exitCode: result.exitCode, timedOut: result.timedOut };
    },
    kill() {
      if (session.child.connected) session.child.send({ type: 'kill' }, () => {});
      const timer = setTimeout(() => session.child.kill('SIGKILL'), 2000);
      timer.unref();
      session.child.once('close', () => clearTimeout(timer));
    },
    dispose() {
      if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill('SIGKILL');
    },
  };
}

export async function shutdownMxcHelpers() {
  shuttingDown = true;
  await Promise.all(
    [...helpers].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
}

export const mxcHelpers = {
  launch: launchHelper,
  probe: probeMxcHelper,
  spawn: spawnMxcHelper,
  shutdown: shutdownMxcHelpers,
};
