import { EventEmitter } from 'node:events';
import { finished, PassThrough, type Readable, type Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecutionMetadata } from '@microsoft/mxc-sdk/v1';

export interface MxcDriver {
  id: number;
  standardInput: Writable | null;
  standardOutput: Readable | null;
  standardError: Readable | null;
  outputMetadata?: ExecutionMetadata;
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): void;
  dispose(): void;
}

/** Only the piped ChildProcess surface used by adapters; no PTY, IPC or detached PID killing. */
export class MxcChildProcess extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdio;
  readonly spawnfile: string;
  readonly spawnargs: string[];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly connected = false;
  constructor(
    private driver: MxcDriver,
    command: string,
    args: string[],
    onMetadata: (metadata?: ExecutionMetadata) => Promise<void> = async () => {},
    onFailure: (error: unknown) => void = () => {},
    onSuccess: () => void = () => {},
  ) {
    super();
    this.pid = driver.id > 0 ? driver.id : undefined;
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    this.stdin = driver.standardInput ?? new PassThrough();
    this.stdout = driver.standardOutput ?? PassThrough.from([]);
    this.stderr = driver.standardError ?? PassThrough.from([]);
    this.stdio = [this.stdin, this.stdout, this.stderr];
    this.stdin.on('error', () => {});
    const drained = [this.stdout, this.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => finished(stream, { readable: true, writable: false }, () => resolve())),
    );
    // Allow spawnTarget to register ownership and consumers to attach before any terminal events.
    setImmediate(() => {
      this.emit('spawn');
      setImmediate(() => {
        void (async () => {
          try {
            // Finalisation failures can also retain sensitive ETL outside the run directory.
            // Always clean metadata before adapters/controller observe a terminal event.
            const result = await (async () => {
              try {
                return await driver.wait();
              } finally {
                await onMetadata(driver.outputMetadata);
              }
            })();
            onSuccess();
            this.exitCode = result.exitCode;
            this.emit('exit', this.exitCode, this.signalCode);
            let drainTimer: NodeJS.Timeout | undefined;
            await Promise.race([
              Promise.all(drained),
              new Promise<void>((resolve) => {
                drainTimer = setTimeout(resolve, 1000);
              }),
            ]);
            clearTimeout(drainTimer);
            this.stdout.destroy();
            this.stderr.destroy();
          } catch (error) {
            onFailure(error);
            this.exitCode = 1;
            this.emit('error', new Error('runtime-permission-or-sandbox-error'));
            this.stdout.destroy();
            this.stderr.destroy();
          } finally {
            this.stdin.destroy();
            try {
              driver.dispose();
            } catch {
              /* wait already settled the native handle. */
            }
            this.emit('close', this.exitCode, this.signalCode);
          }
        })();
      });
    });
  }
  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null) return false;
    this.driver.kill();
    this.killed = true;
    return true;
  }
  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}
