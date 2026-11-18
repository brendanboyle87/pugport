import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freemem, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { HindsightRuntimeStatus } from '../shared/hindsight.ts';
import { HindsightModelBridge, type HindsightBridgeHost, type HindsightJob } from './hindsight-model-bridge.ts';
import { listenLoopback } from './platform/loopback-port.ts';
import { spawn, type ChildProcessWithoutNullStreams } from './platform/test-process.ts';
import { restrictDirectory, restrictFile } from './platform/secure-file.ts';
import { writePrivateConfig } from './private-config.ts';

export type HindsightRuntimeHost = HindsightBridgeHost & {
  scriptPath: string;
  spawn?: typeof spawn;
  startupTimeoutMs?: number;
  pg0InstancesDir?: string;
  freeMemory?: () => number;
  memoryCheckIntervalMs?: number;
};

const startupMemoryBytes = 2.5 * 1024 ** 3;
const minimumFreeMemoryBytes = 1024 ** 3;
const memoryDetail =
  'Hindsight paused because available system memory is low. Local project memory remains available. Free memory, then switch the pilot off and on to retry.';

export async function hindsightDatabaseUrl(stateDir: string, pg0InstancesDir?: string): Promise<string> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (lstatSync(stateDir).isSymbolicLink()) throw new Error('Hindsight state must be a private directory.');
  await restrictDirectory(stateDir);
  const home = join(stateDir, 'home');
  const file = join(stateDir, 'database.json');
  let stored: { version: number; username: string; password: string; instance: string };
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) throw new Error('Invalid Hindsight database identity.');
    await restrictFile(file);
    const text = readFileSync(file, 'utf8');
    if (text.length > 4096) throw new Error('Invalid Hindsight database identity.');
    stored = JSON.parse(text);
    if (
      stored?.version !== 1 ||
      !/^pugport_[a-f0-9]{16}$/.test(stored.username) ||
      !/^[a-f0-9]{64}$/.test(stored.password) ||
      !/^pugport-[a-f0-9]{32}$/.test(stored.instance)
    )
      throw new Error('Invalid Hindsight database identity.');
  } else {
    if (existsSync(join(stateDir, 'database-instance')) || (existsSync(home) && readdirSync(home).length))
      throw new Error('Existing Hindsight data requires its saved database identity.');
    stored = {
      version: 1,
      username: `pugport_${randomBytes(8).toString('hex')}`,
      password: randomBytes(32).toString('hex'),
      instance: `pugport-${randomBytes(16).toString('hex')}`,
    };
    await writePrivateConfig(file, JSON.stringify(stored), '');
  }
  if (!existsSync(join(stateDir, 'database-instance')))
    await writePrivateConfig(join(stateDir, 'database-instance'), stored.instance, '');
  // pg0 uses Windows Known Folders, which ignores the Python process's HOME override.
  const instances = pg0InstancesDir ?? join(process.platform === 'win32' ? homedir() : home, '.pg0', 'instances');
  const instanceDirectory = join(instances, stored.instance);
  mkdirSync(instanceDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(instanceDirectory).isSymbolicLink()) throw new Error('Invalid Hindsight database directory.');
  await restrictDirectory(instanceDirectory);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  await restrictDirectory(home);
  return `pg0://${stored.username}:${stored.password}@${stored.instance}`;
}

/** An owned process, private database home, and ephemeral credentials; never attaches to an ambient daemon. */
export class HindsightRuntime {
  private view: HindsightRuntimeStatus = { state: 'disabled' };
  private child?: ChildProcessWithoutNullStreams;
  private bridge?: HindsightModelBridge;
  private connection?: { baseUrl: string; token: string };
  private starting?: Promise<void>;
  private generation = 0;
  private stopping?: Promise<void>;

  constructor(private host: HindsightRuntimeHost) {}

  status(): HindsightRuntimeStatus {
    if (!this.host.getSettings().enabled) return { state: 'disabled' };
    return { ...this.view };
  }

  endpoint(): { baseUrl: string; token: string } | null {
    return this.host.getSettings().enabled && this.view.state === 'ready' && this.connection
      ? { ...this.connection }
      : null;
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.connection && this.host.getSettings().enabled) return Promise.resolve();
    const pending = this.launch(++this.generation).catch(() => {
      this.view = {
        state: 'unavailable',
        detail: 'Hindsight could not start. Check the configured Python environment and installed local models.',
      };
    });
    this.starting = pending;
    void pending.finally(() => {
      if (this.starting === pending) this.starting = undefined;
    });
    return pending;
  }

  private async launch(generation: number) {
    await this.stopping;
    if (generation !== this.generation) return;
    const settings = this.host.getSettings();
    if (!settings.enabled) {
      this.view = { state: 'disabled' };
      return;
    }
    if (!settings.pythonExecutable || !isAbsolute(settings.pythonExecutable)) {
      this.view = {
        state: 'unavailable',
        detail: 'Choose the absolute path to a Python environment with Hindsight 1.1.0 installed.',
      };
      return;
    }
    if ((this.host.freeMemory ?? freemem)() < startupMemoryBytes) {
      this.view = { state: 'unavailable', detail: memoryDetail };
      return;
    }
    this.view = { state: 'starting' };
    const databaseUrl = await hindsightDatabaseUrl(this.host.stateDir, this.host.pg0InstancesDir);
    const home = join(this.host.stateDir, 'home');
    if (generation !== this.generation || !this.host.getSettings().enabled) return;
    const bridge = new HindsightModelBridge(this.host);
    this.bridge = bridge;
    try {
      const bridgeUrl = await bridge.start();
      const portServer = createServer();
      const port = await new Promise<number>((resolve, reject) => {
        portServer.once('error', reject);
        listenLoopback(portServer, 0, () => {
          const port = (portServer.address() as AddressInfo).port;
          portServer.close((error) => (error ? reject(error) : resolve(port)));
        });
      });
      if (generation !== this.generation || !this.host.getSettings().enabled)
        throw new Error('Hindsight startup cancelled.');
      const token = randomBytes(32).toString('hex');
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL'])
        if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { HOME: home, USERPROFILE: home, PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' });
      const child = (this.host.spawn ?? spawn)(
        settings.pythonExecutable,
        ['-I', '-X', 'utf8', '-u', this.host.scriptPath],
        {
          cwd: this.host.stateDir,
          env,
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ) as ChildProcessWithoutNullStreams;
      this.child = child;
      // Observe host pressure, not just this child: the foreground application takes priority.
      const memoryTimer = setInterval(() => {
        if (generation !== this.generation || this.child !== child) {
          clearInterval(memoryTimer);
          return;
        }
        if ((this.host.freeMemory ?? freemem)() >= minimumFreeMemoryBytes) return;
        clearInterval(memoryTimer);
        void this.stop().catch(() => undefined);
        this.view = { state: 'unavailable', detail: memoryDetail };
      }, this.host.memoryCheckIntervalMs ?? 1000);
      memoryTimer.unref();
      child.once('exit', () => clearInterval(memoryTimer));
      child.once('error', () => clearInterval(memoryTimer));
      await new Promise<void>((resolve, reject) => {
        let output = '';
        let settled = false;
        const timeout = setTimeout(
          () => done(new Error('Hindsight startup timed out.')),
          this.host.startupTimeoutMs ?? 180_000,
        );
        const done = (error?: Error) => {
          if (settled) return;
          settled = true;
          output = '';
          clearTimeout(timeout);
          error ? reject(error) : resolve();
        };
        child.once('error', () => done(new Error('Hindsight process failed.')));
        child.once('exit', () => {
          if (this.child === child) {
            this.child = undefined;
            this.connection = undefined;
            if (generation === this.generation)
              this.view = {
                state: 'unavailable',
                detail: 'Hindsight stopped. Local project memory remains available.',
              };
            void bridge.stop();
          }
          done(new Error('Hindsight process exited.'));
        });
        child.stderr.on('data', () => undefined);
        child.stdout.on('data', (chunk: Buffer) => {
          if (settled) return;
          output += chunk.toString('utf8');
          if (output.length > 16_384) {
            done(new Error('Unexpected Hindsight startup output.'));
            return;
          }
          if (output.split(/\r?\n/).includes('PUGPORT_HINDSIGHT_READY 1.1.0')) done();
        });
        child.stdin.on('error', () => done(new Error('Hindsight control pipe closed.')));
        child.stdin.write(
          `${JSON.stringify({ port, token, bridgeToken: bridge.token, bridgeUrl, stateDir: this.host.stateDir, databaseUrl })}\n`,
        );
      });
      if (
        generation !== this.generation ||
        !this.host.getSettings().enabled ||
        this.child !== child ||
        child.exitCode !== null
      )
        throw new Error('Hindsight startup cancelled.');
      this.connection = { baseUrl: `http://127.0.0.1:${port}`, token };
      this.view = { state: 'ready', version: '1.1.0' };
    } catch {
      if (generation === this.generation) {
        await this.stopOwned();
        if (generation === this.generation)
          this.view = {
            state: this.host.getSettings().enabled ? 'unavailable' : 'disabled',
            detail:
              'Hindsight could not start. Check Python 3.11+, Hindsight 1.1.0, and preinstalled local embedding files.',
          };
      }
    }
  }

  withJob<T>(context: HindsightJob, work: () => Promise<T>): Promise<T> {
    if (!this.endpoint() || !this.bridge) return Promise.reject(new Error('Hindsight is not ready.'));
    return this.bridge.withJob(context, work);
  }

  yieldToForeground() {
    this.bridge?.cancelJob();
  }

  private async stopOwned() {
    this.connection = undefined;
    const child = this.child;
    this.child = undefined;
    const bridge = this.bridge;
    this.bridge = undefined;
    await bridge?.stop();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (process.platform !== 'win32' && child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill();
            }
          } else child.kill();
        }, 12_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.stdin.end('stop\n');
      });
    }
  }

  stop(): Promise<void> {
    ++this.generation;
    this.view = { state: this.host.getSettings().enabled ? 'unavailable' : 'disabled' };
    if (this.stopping) return this.stopping;
    const starting = this.starting;
    const pending = (async () => {
      await this.stopOwned();
      await starting;
    })();
    this.stopping = pending;
    void pending.finally(() => {
      if (this.stopping === pending) this.stopping = undefined;
    });
    return pending;
  }
}
