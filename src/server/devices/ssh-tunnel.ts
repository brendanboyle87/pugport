import { createServer, connect } from 'node:net';
import { get } from 'node:http';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnTarget, terminateProcess } from '../adapters/process.ts';
import { hardenedSshSettings } from '../ssh-options.ts';
import { managedSshArgs, type ManagedRoute } from './managed-access.ts';

// ClearAllForwardings would also clear the -L given on the command line.
const settings = [
  ...hardenedSshSettings.filter((setting) => setting !== 'ClearAllForwardings=yes'),
  'ExitOnForwardFailure=yes',
];
const tunnelArgs = (port: number, remotePort: number) => [
  '-N',
  '-T',
  '-n',
  '-L',
  `127.0.0.1:${port}:127.0.0.1:${remotePort}`,
  ...settings.flatMap((s) => ['-o', s]),
];

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** An alias from the owner's own SSH config, or the account's managed key (named `access:<device id>`). */
export type TunnelRoute = string | (ManagedRoute & { name: string });
const routeName = (route: TunnelRoute) => (typeof route === 'string' ? route : route.name);
const destination = (route: TunnelRoute) =>
  typeof route === 'string' ? ['--', route] : [...managedSshArgs(route), '--', route.host];

type Child = ChildProcessWithoutNullStreams;
type Dependencies = {
  launch(args: string[]): Promise<Child>;
  terminate(child: Child): Promise<void>;
  port(): Promise<number>;
  ready(port: number): Promise<boolean>;
  now(): number;
  pause(ms: number): Promise<void>;
};
const defaults: Dependencies = {
  launch: (args) =>
    spawnTarget(
      {
        id: 'ssh-tunnel',
        provider: 'codex',
        label: 'SSH tunnel',
        command: 'ssh',
        environment: 'native',
        enabled: true,
      },
      args,
      { syncAccountConfig: false },
    ),
  terminate: terminateProcess,
  port: () =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('No local port'));
          return;
        }
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    }),
  ready: (port) =>
    new Promise((resolve) => {
      const request = get({ host: '127.0.0.1', port, path: '/peer/v1/info', timeout: 500 }, (response) => {
        response.resume();
        resolve(true);
      });
      request.on('error', () => resolve(false));
      request.on('timeout', () => request.destroy());
    }),
  now: Date.now,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class SshTunnels {
  private readonly deps: Dependencies;
  private readonly open = new Map<string, { port: number; remotePort: number; child: Child }>();
  private readonly pending = new Map<string, Promise<number>>();
  private readonly failed = new Map<string, { at: number; error: Error }>();
  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...deps };
  }

  isOpen(name: string): boolean {
    return this.open.has(name);
  }

  forget(name: string): void {
    this.failed.delete(name);
  }

  async ensure(route: TunnelRoute, remotePort: number): Promise<number> {
    const name = routeName(route);
    if (
      !(typeof route === 'string' ? aliasPattern.test(route) : /^access:[0-9a-f-]{36}$/i.test(route.name)) ||
      !Number.isInteger(remotePort) ||
      remotePort < 1 ||
      remotePort > 65535
    )
      throw new Error('Invalid SSH tunnel target.');
    const active = this.open.get(name);
    if (active && active.remotePort === remotePort) return active.port;
    if (active) await this.close(name);
    const failure = this.failed.get(name);
    if (failure && this.deps.now() - failure.at < 30_000) throw failure.error;
    const pending = this.pending.get(name);
    if (pending) return pending;
    const promise = this.start(route, remotePort).finally(() => this.pending.delete(name));
    this.pending.set(name, promise);
    return promise;
  }

  private async start(route: TunnelRoute, remotePort: number): Promise<number> {
    const name = routeName(route);
    let child: Child | undefined;
    let stderr = '';
    let exited = false;
    try {
      const port = await this.deps.port();
      child = await this.deps.launch([...tunnelArgs(port, remotePort), ...destination(route)]);
      const process = child;
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 1024) stderr += chunk.toString().slice(0, 1024 - stderr.length);
      });
      child.once('error', () => {
        exited = true;
      });
      child.once('close', () => {
        exited = true;
        if (this.open.get(name)?.child === process) this.open.delete(name);
      });
      const deadline = this.deps.now() + 10_000;
      while (!exited && this.deps.now() < deadline) {
        if (await this.deps.ready(port)) {
          if (exited) break;
          this.open.set(name, { port, remotePort, child });
          this.failed.delete(name);
          return port;
        }
        await this.deps.pause(200);
      }
      throw new Error('Tunnel unavailable');
    } catch (cause) {
      if (child) await this.deps.terminate(child).catch(() => {});
      const line = stderr.split(/\r?\n/)[0]?.trim() || (cause instanceof Error ? cause.message : 'SSH failed');
      const error = Object.assign(
        new Error(
          typeof route === 'string'
            ? `打不开到 ${name} 的 SSH 隧道：${line}`
            : `打不开到 ${route.label} 的账号直连隧道：${line}`,
        ),
        { sshOutput: stderr },
      );
      this.failed.set(name, { at: this.deps.now(), error });
      throw error;
    }
  }

  async close(name: string): Promise<void> {
    const pending = this.pending.get(name);
    if (pending) await pending.catch(() => {});
    const item = this.open.get(name);
    this.open.delete(name);
    this.failed.delete(name);
    if (item) await this.deps.terminate(item.child);
  }
}

/** The server turned the managed key away (key, host key or forward refused), not merely unreachable. */
export const managedKeyRefused = (error: unknown) =>
  /Permission denied|Host key verification failed|HOST IDENTIFICATION HAS CHANGED|administratively prohibited/.test(
    String((error as { sshOutput?: unknown } | undefined)?.sshOutput ?? ''),
  );

/** Tests forwarding without sending credentials or connecting to the peer node. */
export async function checkSshForward(alias: string, sshdPort: number): Promise<boolean> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(alias) ||
    !Number.isInteger(sshdPort) ||
    sshdPort < 1 ||
    sshdPort > 65535
  )
    return false;
  const port = await defaults.port();
  const child = await defaults.launch([...tunnelArgs(port, sshdPort), '--', alias]);
  let ended = false;
  child.stderr.resume();
  child.once('error', () => {
    ended = true;
  });
  child.once('close', () => {
    ended = true;
  });
  const deadline = Date.now() + 3000;
  try {
    while (!ended && Date.now() < deadline) {
      const ok = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        let text = '';
        const finish = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(300, () => finish(false));
        socket.once('error', () => finish(false));
        socket.on('data', (bytes) => {
          text += bytes.toString();
          if (text.includes('SSH-2.0')) finish(true);
          else if (text.length > 1024) finish(false);
        });
        socket.once('end', () => finish(false));
      });
      if (ok) return true;
      await defaults.pause(100);
    }
    return false;
  } finally {
    await defaults.terminate(child).catch(() => {});
  }
}
