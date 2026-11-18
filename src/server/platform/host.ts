import * as childProcess from './test-process.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

/**
 * The machine a platform function works for. Every function in this folder takes a host as its last argument,
 * defaulting to the current machine, so macOS and Linux branches can be tested on Windows with a fake host
 * (paths are built only through `host.path`, never through the native `node:path`).
 */
export type RunOptions = {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  maxBuffer?: number;
  windowsHide?: boolean;
  /** Stream a bundle from disk, or a setup script, to stdin without a shell. */
  stdinFile?: string;
  input?: string;
  onOutput?: (text: string) => void;
};
export type RunResult = { stdout: string; stderr: string };
export type Host = {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly tmpdir: string;
  readonly path: typeof path.posix;
  readonly fs: typeof fs;
  /** Runs a program without a shell (execFile); rejects on a non-zero exit, like `promisify(execFile)`. */
  run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** The synchronous form, returning standard output. */
  runSync(file: string, args: readonly string[], options?: RunOptions): string;
  freemem(): number;
  totalmem(): number;
  /** The POSIX user id, undefined on Windows. */
  uid(): number | undefined;
};

function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { stdinFile, input, onOutput, ...execOptions } = options;
    const child = childProcess.execFile(
      file,
      [...args],
      { windowsHide: true, ...execOptions, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    if (onOutput) {
      child?.stdout?.on('data', onOutput);
      child?.stderr?.on('data', onOutput);
    }
    child?.stdin?.on('error', () => {});
    if (stdinFile) {
      const source = fs.createReadStream(stdinFile);
      source.on('error', (error) => {
        child.kill();
        reject(error);
      });
      child.once('close', () => source.destroy());
      source.pipe(child.stdin!);
    } else if (input !== undefined) child?.stdin?.end(input);
  });
}

// Module functions are looked up when called, so a test that replaces part of node:os still loads this file.
const machine: Host = {
  platform: process.platform,
  get env() {
    return process.env;
  },
  // POSIX reads HOME the way libuv does; reading it here also follows a replaced process.env.
  get home() {
    return process.platform === 'win32' ? os.homedir() : process.env.HOME || os.homedir();
  },
  get tmpdir() {
    return os.tmpdir();
  },
  path,
  fs,
  run,
  runSync: (file, args, options = {}) =>
    childProcess.execFileSync(file, [...args], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  freemem: () => os.freemem(),
  totalmem: () => os.totalmem(),
  uid: () => process.getuid?.(),
};

export function currentHost(): Host {
  return machine;
}

export type Capabilities = {
  /** Removals can go to the system's Recycle Bin / Trash instead of being deleted. */
  trash: boolean;
  /** A visible terminal can be opened for a CLI account login. */
  accountLogin: boolean;
  /** A GPU usage reading may exist (it can still be unavailable on a given machine). */
  gpu: boolean;
  /** macOS Shortcuts. */
  shortcuts: boolean;
};

export function capabilities(host: Host = currentHost()): Capabilities {
  const windows = host.platform === 'win32';
  const mac = host.platform === 'darwin';
  return {
    trash: windows || mac || host.platform === 'linux',
    accountLogin: windows || mac,
    gpu: windows || mac || host.platform === 'linux',
    shortcuts: mac,
  };
}
