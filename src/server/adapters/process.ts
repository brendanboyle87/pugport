import { isRetiredProvider } from '../../shared/provider-registry.ts';
import { assertTestProcess } from '../platform/under-test.ts';
import { spawn, type ChildProcessWithoutNullStreams } from '../platform/test-process.ts';
import { spawnPosixTask, markPosixTaskCancelled, posixTaskExecutorPid } from '../platform/posix-task.ts';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { RuntimeTarget, StartupFailure } from '../../shared/types.js';
import { nativeAccountEnvironment } from '../native-accounts.ts';
import { mirrorAccountSharedConfig } from '../account-shared-config.ts';
import type { SandboxRequest } from '../sandbox/policy-builder.ts';
import { commandLine, windowsWrapperCommand } from '../sandbox/command-line.ts';
import { MxcChildProcess } from '../sandbox/mxc-child.ts';
import { mxcExecution } from '../sandbox/mxc-runtime.ts';
import { executionEnvironment } from '../sandbox/run-temp.ts';
import { deleteRetainedEtl } from '../sandbox/learning-report.ts';
import { failureReason } from '../sandbox/helper-protocol.ts';
import { isMxcHelperPid, mxcHelpers } from '../sandbox/helper-client.ts';
import { captureDenialsStreamingSupported } from '../../shared/sandbox-capabilities.ts';
import { cliEnvironment, isRemovedGoogleCliLaunch } from '../platform/executables.ts';
export { isRemovedGoogleCliLaunch } from '../platform/executables.ts';
export { windowsWrapperCommand } from '../sandbox/command-line.ts';

export type TargetSpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  syncAccountConfig?: boolean;
  sandbox?: SandboxRequest;
  runTemp?: string;
  onSandboxFailure?: (reason: string, phase: 'startup' | 'runtime') => void;
  onSandboxSuccess?: () => void;
  signal?: AbortSignal;
};
type OwnedProcess = {
  wsl: boolean;
  mxc?: boolean;
  linuxPid?: string;
  stop?: Promise<void>;
  closed: boolean;
  posixGroup: boolean;
};
const owned = new WeakMap<ChildProcessWithoutNullStreams, OwnedProcess>();
const liveOwned = new Set<ChildProcessWithoutNullStreams>();
const pendingMxc = new Set<Promise<void>>();
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

type CliDiagnosticCode = 'authentication-required' | 'runtime-protocol-incompatible';
const incompatibleOption =
  /\b(?:invalid|unknown|unrecognized|unexpected)\s+(?:option|flag|subcommand)\b|\b(?:unknown|unrecognized|unexpected)\s+argument\b|\bargument\s+'[^']*'\s+is\s+invalid\b|\ballowed choices\b|\btoo many arguments\b|\bmissing required (?:option|argument)\b/i;

/** Interpret native startup diagnostics without returning their account data or raw text. */
export class CliDiagnosticCapture {
  #tail = '';
  code?: CliDiagnosticCode;

  write(chunk: string): void {
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      const text = (this.#tail + chunk.slice(offset, offset + 4096)).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (incompatibleOption.test(text)) this.code = 'runtime-protocol-incompatible';
      else if (
        !this.code &&
        /\b(?:not[ -]+(?:authenticated|logged[ -]+in|signed[ -]+in)|authentication required|login required|invalid_grant)\b|\b(?:access|refresh|oauth)[ _-]?token.{0,48}(?:expired|invalid)\b|\b(?:expired|invalid).{0,48}(?:access|refresh|oauth)[ _-]?token\b/i.test(
          text,
        )
      )
        this.code = 'authentication-required';
      this.#tail = text.slice(-4096);
    }
  }
}

/** Do not return stderr, JSON-RPC diagnostics, URLs or environment values to the UI. */
export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (message === 'wsl-runtime-retired' || /^runtime-image-(?:input-unavailable|input-invalid|dropped)$/.test(message))
    return message;
  if (/^api-budget-(?:exhausted|expired|usage-unknown)$/.test(message)) return message;
  if (message === 'provider-retired' || message === 'privacy-text-only') return message;
  if (
    /^(?:runtime-(?:not-found|timeout|permission-or-sandbox-error|protocol-incompatible|process-closed|network-error|request-failed|model-unavailable)|native-session-unavailable|native-session-identity-(?:changed|unverified)|authentication-required|api-key-auth-or-configuration|api-key-workspace-required|quota-or-rate-limit|provider-refused|operation-cancelled|unsafe-wrapper-argument|unsupported-runtime-wrapper|unsupported-wsl-path)$/.test(
      message,
    )
  )
    return message;
  if (code === 'ENOENT' || /runtime-not-found|not found|not recognized/i.test(message)) return 'runtime-not-found';
  if (/unsafe-wrapper-argument/.test(message)) return 'unsafe-wrapper-argument';
  if (/unsupported-runtime-wrapper/.test(message)) return 'unsupported-runtime-wrapper';
  if (/unsupported-wsl-path/.test(message)) return 'unsupported-wsl-path';
  // A policy/permission rejection must not be mistaken for a retryable quota
  // or timeout merely because the diagnostic also mentions those words.
  if (
    /sandbox|permission|EACCES|EPERM|(?:blocked|denied|rejected)\s+by\s+(?:policy|safety)/i.test(message) ||
    code === 'EACCES' ||
    code === 'EPERM'
  )
    return 'runtime-permission-or-sandbox-error';
  if (/abort|cancel|interrupt/i.test(message)) return 'operation-cancelled';
  if (/not.?authenticated|not.?logged.?in|authentication required|unauthori[sz]ed|login required/i.test(message))
    return 'authentication-required';
  // Anthropic keys made outside a workspace are refused unless every request names one.
  if (/not scoped to a workspace|anthropic-workspace-id/i.test(message)) return 'api-key-workspace-required';
  if (/api.?key/i.test(message)) return 'api-key-auth-or-configuration';
  if (/usage.?limit|quota|rate.?limit|429/i.test(message)) return 'quota-or-rate-limit';
  if (/timeout|timed out/i.test(message)) return 'runtime-timeout';
  if (/method not found|invalid params|unknown variant|protocol|invalid.?json|unsupported/i.test(message))
    return 'runtime-protocol-incompatible';
  if (/closed|exited|EPIPE/i.test(message)) return 'runtime-process-closed';
  if (/network|fetch|connect|socket/i.test(message)) return 'runtime-network-error';
  return 'runtime-request-failed';
}

type RuntimeErrorOptions = {
  provider?: string;
  code?: string;
  secrets?: (string | undefined)[];
  paths?: (string | undefined)[];
  prompt?: string;
};

/** Replace the given folders, the data folder and the home folder with a placeholder, any slash style. */
export function redactPaths(text: string, paths: readonly (string | undefined)[]): string {
  for (const path of [...paths, process.env.COMBORUNNER_DATA_DIR, homedir()]
    .filter((value): value is string => !!value)
    .sort((a, b) => b.length - a.length)) {
    const escaped = path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[/\\\\]+');
    text = text.replace(new RegExp(escaped, 'gi'), '[private path]');
  }
  return text;
}

function redactRuntimeDetail(detail: string, options: RuntimeErrorOptions, limit: number, inherited: boolean): string {
  // Match the original request before path/key substitutions change it, including JSON echoes.
  if (options.prompt && options.prompt.length >= 16)
    for (const prompt of [options.prompt, JSON.stringify(options.prompt).slice(1, -1)])
      detail = detail.split(prompt).join('[redacted prompt]');
  for (const secret of options.secrets ?? []) if (secret) detail = detail.split(secret).join('[redacted]');
  detail = redactPaths(detail, options.paths ?? []);
  // Error envelopes sometimes include the rejected request. Never keep its body.
  detail = detail.replace(
    /(?:"(?:prompt|messages|input|content|file_content)"\s*:\s*[\[{"]|\bprompt=)[\s\S]*/gi,
    '[redacted request]',
  );
  if (!inherited) detail = detail.replace(/(["']?authorization["']?\s*[:=]\s*)[^\r\n,;}]+/gi, '$1[redacted]');
  return redactToolDiagnostic(`${!inherited && options.provider ? `${options.provider}: ` : ''}${detail}`, limit);
}

/** Only structured provider messages opt in to detail; wrappers preserve already sanitized detail. */
export function runtimeError(
  error: unknown,
  options: RuntimeErrorOptions = {},
): Error & { detail?: string; startup?: StartupFailure } {
  const result = new Error(options.code ?? redactError(error));
  const source = error instanceof Error ? (error as Error & { detail?: string; startup?: StartupFailure }) : undefined;
  const inherited = source?.detail;
  const startup = source?.startup;
  const attach = (detail?: string) => {
    if (detail) Object.assign(result, { detail });
    if (startup) Object.assign(result, { startup });
    return result;
  };
  const detail =
    inherited ??
    (options.provider ? (error instanceof Error ? error.message : typeof error === 'string' ? error : '') : '');
  if (!detail) return attach();
  const redacted = redactRuntimeDetail(detail, options, 500, inherited !== undefined);
  return attach(redacted);
}

const STARTUP_LINES = 20;
const STARTUP_CHARS = 4096;

function stripAnsi(value: string): string {
  return value.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function jsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function startupSuffix(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= STARTUP_CHARS) return value;
  let start = bytes.length - STARTUP_CHARS;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function rememberStartup(lines: string[], line: string): void {
  lines.push(startupSuffix(line));
  while (lines.length > STARTUP_LINES || (lines.length > 1 && Buffer.byteLength(lines.join('\n')) > STARTUP_CHARS))
    lines.shift();
}

/** Stderr plus non-JSON stdout, kept until the adapter finishes its handshake. */
export class StartupTail {
  #lines: string[] = [];
  #pending = { stdout: '', stderr: '' };
  #decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  #discardStdout = false;
  #done = false;
  #started = Date.now();

  get active(): boolean {
    return !this.#done;
  }

  write(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    if (this.#done) return;
    const text = stripAnsi(typeof chunk === 'string' ? chunk : this.#decoders[stream].write(chunk));
    const parts = (this.#pending[stream] + text).split('\n');
    this.#pending[stream] = parts.pop() ?? '';
    for (const part of parts) {
      if (stream === 'stdout' && this.#discardStdout) {
        this.#discardStdout = false;
        continue;
      }
      const line = part.replace(/\r$/, '');
      if (stream === 'stdout' && (/^\s*[\[{]/.test(line) || jsonLine(line))) continue;
      rememberStartup(this.#lines, line);
    }
    if (Buffer.byteLength(this.#pending[stream]) > STARTUP_CHARS) {
      if (stream === 'stdout' && (this.#discardStdout || /^\s*[\[{"]/.test(this.#pending[stream]))) {
        this.#discardStdout = true;
        this.#pending[stream] = '';
      } else this.#pending[stream] = startupSuffix(this.#pending[stream]);
    }
  }

  text(): string {
    const lines = this.#lines.slice();
    if (!this.#done)
      for (const stream of ['stderr', 'stdout'] as const) {
        const pending = this.#pending[stream].replace(/\r$/, '');
        if (
          pending &&
          !(stream === 'stdout' && (this.#discardStdout || /^\s*[\[{]/.test(pending) || jsonLine(pending)))
        )
          rememberStartup(lines, pending);
      }
    return lines.join('\n');
  }

  /** Stop recording. A later close is not a startup failure. */
  done(): void {
    this.#done = true;
    this.#lines = [];
    this.#pending.stdout = '';
    this.#pending.stderr = '';
  }

  failure(
    provider: string,
    exitCode: number | null,
    options: Pick<RuntimeErrorOptions, 'paths' | 'secrets' | 'prompt'> = {},
  ): Error & { detail?: string; startup: StartupFailure } {
    let tail = this.text();
    const capture = new CliDiagnosticCapture();
    if (tail) capture.write(tail);
    if (options.prompt?.includes('\n'))
      for (const part of options.prompt.split(/\r?\n/))
        if (part.length >= 16) tail = tail.split(part).join('[redacted prompt]');
    const error = runtimeError(new Error(tail), {
      code: capture.code ?? 'runtime-process-closed',
      provider,
      ...options,
    });
    const lines = tail.split('\n');
    const rawLine = lines.find((line) => incompatibleOption.test(line)) ?? lines.find((line) => line.trim()) ?? '';
    const firstLine = rawLine ? redactRuntimeDetail(rawLine, options, 200, false) : '';
    const startup: StartupFailure = {
      exitCode,
      elapsedMs: Math.max(0, Date.now() - this.#started),
      ...(firstLine ? { firstLine } : {}),
    };
    return Object.assign(error, { startup });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve executable names without invoking a shell or reading wrapper contents. */
export async function resolveExecutable(command: string, env = process.env): Promise<string> {
  if (!command || command.includes('\0')) throw new Error('runtime-not-found');
  const explicit = isAbsolute(command) || command.includes('/') || command.includes('\\');
  // PATH first; macOS/Linux then the search folders, since a Finder-started app's PATH misses Homebrew's npx,
  // uvx and npm's CLIs. Windows: PATH only.
  const directories = explicit
    ? ['']
    : (cliEnvironment(command, env).PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32' && !/\.(exe|com|cmd|bat|ps1)$/i.test(command)
      ? ['.exe', '.com', '.cmd', '.bat', '']
      : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = explicit
        ? resolve(command + extension)
        : join(directory.replace(/^"|"$/g, ''), command + extension);
      if (await exists(candidate)) return candidate;
    }
  }
  throw Object.assign(new Error('runtime-not-found'), { code: 'ENOENT' });
}

/** How Windows ends a CLI's whole process tree (POSIX signals the process group instead). */
export function windowsTreeKill(pid: number, systemRoot = process.env.SystemRoot) {
  return {
    file: join(systemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    args: ['/pid', String(pid), '/t', '/f'],
  };
}

/** Whether `pid` is a process this module started that is still running (an executor or one of its helpers). */
export function isOwnedProcess(pid: number): boolean {
  if (isMxcHelperPid(pid)) return true;
  for (const child of liveOwned)
    if (!owned.get(child)?.closed && (child.pid === pid || posixTaskExecutorPid(child) === pid)) return true;
  return false;
}

function assertSpawnAllowed() {
  if (shuttingDown) throw new Error('operation-cancelled');
}

function registerOwned(child: ChildProcessWithoutNullStreams, mxc = false) {
  const state: OwnedProcess = { wsl: false, mxc, closed: false, posixGroup: process.platform !== 'win32' && !mxc };
  owned.set(child, state);
  liveOwned.add(child);
  child.once('close', () => {
    state.closed = true;
    if (state.posixGroup && child.pid && processGroupAlive(child.pid)) {
      // A group ID cannot be reused while any of its members remain. Start cleanup now, while
      // ownership is continuous, instead of saving the exited leader's PID for a future shutdown.
      // Keep a failed cleanup in liveOwned so application shutdown still reports the failure.
      void terminateProcess(child).catch(() => {});
    } else {
      state.posixGroup = false;
      liveOwned.delete(child);
    }
  });
}

function rawSpawn(
  command: string,
  args: string[],
  options: TargetSpawnOptions = {},
  verbatim = false,
  cleanup = false,
): ChildProcessWithoutNullStreams {
  // Cleanup primitives are awaited with bounded output-capture deadlines by terminateProcess.
  // All ordinary launches, including temporary wslpath discovery helpers, share this gate.
  if (!cleanup) assertSpawnAllowed();
  const launch =
    !cleanup && process.platform !== 'win32' && process.env.PUGPORT_POSIX_GUARD_SOCKET ? spawnPosixTask : spawn;
  const child = launch(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: verbatim,
    // Detached POSIX CLIs escape launchd; the backend's graceful shutdown must stop them.
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams;
  if (!cleanup) {
    registerOwned(child);
  }
  // Prevent an early EPIPE from becoming an uncaught EventEmitter error; clients still receive it.
  child.stdin.on('error', () => {});
  return child;
}

function started(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveStart, reject) => {
    child.once('spawn', resolveStart);
    child.once('error', reject);
  });
}

/** WSL targets are kept only as historical metadata. Never launch a path helper. */
export async function targetPath(target: RuntimeTarget, path: string): Promise<string> {
  if (target.environment === 'wsl' || target.id === 'codex-wsl') throw new Error('wsl-runtime-retired');
  return resolve(path);
}

export async function spawnTarget(
  target: RuntimeTarget,
  args: string[],
  options: TargetSpawnOptions = {},
): Promise<ChildProcessWithoutNullStreams> {
  if (isRetiredProvider(target.provider)) throw new Error('provider-retired');
  if (target.environment === 'wsl' || target.id === 'codex-wsl') throw new Error('wsl-runtime-retired');
  if (isRemovedGoogleCliLaunch({ command: target.command, args: [...(target.args ?? []), ...args] }))
    throw new Error('provider-retired');
  // Under test, a bare name is checked where resolveExecutable will find it.
  assertTestProcess(
    target.command,
    [...(target.args ?? []), ...args],
    true,
    cliEnvironment(target.command, options.env ?? process.env),
  );
  assertSpawnAllowed();
  if (options.signal?.aborted) throw new Error('operation-cancelled');
  const source = options.env ?? process.env;
  const env = nativeAccountEnvironment(target, source);
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'pugport_executor') delete env[key];
  options = { ...options, env: { ...env, PUGPORT_EXECUTOR: '1' } };
  if (target.accountId && options.syncAccountConfig !== false) await mirrorAccountSharedConfig(target, source);
  let sandboxAvailable = false;
  if (options.sandbox) {
    try {
      const status = await mxcExecution.status();
      sandboxAvailable = status.available;
      if (
        options.sandbox.containment?.type === 'processcontainer' &&
        options.sandbox.containment.config?.captureDenials &&
        !captureDenialsStreamingSupported(status.sdkVersion)
      ) {
        options = { ...options, sandbox: undefined, runTemp: undefined };
        sandboxAvailable = false;
      }
    } catch (error) {
      options.onSandboxFailure?.(failureReason(error), 'startup');
    }
  }
  const targetArgs = [...(target.args ?? []), ...args];
  if (options.runTemp || options.sandbox)
    options = {
      ...options,
      env: executionEnvironment(options.env ?? process.env, options.runTemp ?? options.sandbox?.runTemp),
    };
  if ([target.command, ...targetArgs].some((value) => value.includes('\0')))
    throw new Error('runtime-protocol-incompatible');
  let child: ChildProcessWithoutNullStreams;
  const command = await resolveExecutable(target.command, options.env);
  options = { ...options, env: cliEnvironment(command, options.env ?? process.env) };
  assertSpawnAllowed();
  if (options.signal?.aborted) throw new Error('operation-cancelled');
  if (options.sandbox && sandboxAvailable) {
    assertSpawnAllowed();
    const {
      provider: _provider,
      runTemp: _temp,
      reportDirectory: _report,
      fallback: _fallback,
      ...request
    } = options.sandbox;
    let completeLaunch!: () => void;
    const pending = new Promise<void>((resolveLaunch) => {
      completeLaunch = resolveLaunch;
    });
    pendingMxc.add(pending);
    try {
      const driver = await mxcExecution.spawn(
        {
          ...request,
          command: commandLine(command, targetArgs, process.env.SystemRoot),
          environment: { ...request.environment, ...options.env },
        },
        options.signal,
      );
      if (options.signal?.aborted) {
        driver.kill();
        driver.dispose();
        throw new Error('operation-cancelled');
      }
      child = new MxcChildProcess(
        driver,
        command,
        targetArgs,
        deleteRetainedEtl,
        (error) => options.onSandboxFailure?.(failureReason(error), 'runtime'),
        () => options.onSandboxSuccess?.(),
      ).asChildProcess();
      registerOwned(child, true);
    } catch (error) {
      assertSpawnAllowed();
      if (options.signal?.aborted) throw new Error('operation-cancelled');
      if ((error as NodeJS.ErrnoException)?.code !== 'sandbox-learning-unavailable')
        options.onSandboxFailure?.(failureReason(error), 'startup');
      // Learning never stops execution. Reuse the normal launcher with the same CLI args/env/cwd.
      child = spawnOrdinary(command, targetArgs, options);
    } finally {
      pendingMxc.delete(pending);
      completeLaunch();
    }
  } else child = spawnOrdinary(command, targetArgs, options);
  await started(child);
  if (shuttingDown) {
    await terminateProcess(child);
    throw new Error('operation-cancelled');
  }
  return child;
}

function spawnOrdinary(command: string, args: string[], options: TargetSpawnOptions) {
  if (options.signal?.aborted) throw new Error('operation-cancelled');
  if (/\.(cmd|bat)$/i.test(command)) {
    if (process.platform !== 'win32') throw new Error('unsupported-runtime-wrapper');
    const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    return rawSpawn(cmd, ['/d', '/s', '/c', windowsWrapperCommand(command, args)], options, true);
  } else if (/\.ps1$/i.test(command)) {
    throw new Error('unsupported-runtime-wrapper');
  } else return rawSpawn(command, args, options);
}

async function waitClosed(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveWait) => {
    const done = (closed: boolean) => {
      clearTimeout(timer);
      child.off('close', onClose);
      resolveWait(closed);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    child.once('close', onClose);
  });
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitProcessGroup(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (processGroupAlive(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((done) => setTimeout(done, 25));
  }
  return true;
}

/** rawSpawn gives each POSIX executor its own process group. The leader exiting is not tree cleanup. */
async function terminatePosixGroup(child: ChildProcessWithoutNullStreams, state: OwnedProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || !state.posixGroup) return;
  if (!state.closed) {
    // Flush pending protocol cancellation/approval responses before closing stdin. A cooperative
    // leader may exit on EOF, but that alone does not prove its detached-stdio helpers stopped.
    child.stdin.end();
    await waitClosed(child, 600);
  }
  if (state.posixGroup && processGroupAlive(pid)) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && !(code === 'EPERM' && (await waitProcessGroup(pid, 1000))))
        throw Object.assign(new Error(`Owned CLI process group could not be stopped (PGID ${pid}).`), {
          code: 'owned-processes-still-running',
        });
    }
    // Wait for every group member, even after the direct child's close event.
    if (!(await waitProcessGroup(pid, 500))) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && !(code === 'EPERM' && (await waitProcessGroup(pid, 1000))))
          throw Object.assign(new Error(`Owned CLI process group could not be stopped (PGID ${pid}).`), {
            code: 'owned-processes-still-running',
          });
      }
      if (!(await waitProcessGroup(pid, 1000)))
        throw Object.assign(new Error(`Owned CLI process group did not exit (PGID ${pid}).`), {
          code: 'owned-processes-still-running',
        });
    }
  }
  state.posixGroup = false;
  liveOwned.delete(child);
  await waitClosed(child, 1000);
}

/** Only processes created by this module may be terminated here. Never kill by executable name. */
export async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  const state = owned.get(child);
  if (!state) return;
  if (state.stop) return state.stop;
  if (!state.closed) markPosixTaskCancelled(child);
  state.stop = (async () => {
    if (state.posixGroup) return terminatePosixGroup(child, state);
    if (state.closed) return;
    child.stdin.end();
    if (await waitClosed(child, 600)) return;
    if (state.wsl && state.linuxPid) {
      const stop = rawSpawn(
        'wsl.exe',
        [
          '--exec',
          'bash',
          '-c',
          'kill -TERM -- "-$1" 2>/dev/null || true; sleep 0.2; kill -KILL -- "-$1" 2>/dev/null || true',
          'agent-studio-stop',
          state.linuxPid,
        ],
        {},
        false,
        true,
      );
      await collectProcessOutput(stop, 2500).catch(() => {});
      if (await waitClosed(child, 300)) return;
    }
    if (state.mxc) {
      child.kill('SIGKILL');
      await waitClosed(child, 3000);
      return;
    }
    if (!child.pid || state.closed) return;
    if (process.platform === 'win32') {
      try {
        const tree = windowsTreeKill(child.pid);
        const killer = rawSpawn(tree.file, tree.args, {}, false, true);
        await collectProcessOutput(killer, 3000);
      } catch {
        /* The helper can be denied even when our existing child handle can terminate it. */
      }
      if (!(await waitClosed(child, 300))) {
        // taskkill is needed for the tree, but must not be the only way to stop our direct child.
        try {
          child.kill('SIGKILL');
        } catch {
          /* Preserve bounded, best-effort termination semantics. */
        }
      }
    }
    await waitClosed(child, 1000);
  })();
  return state.stop;
}

/** One-way application shutdown. Stops execution and discovery children, including pending launches. */
export function shutdownOwnedProcesses(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  // rawSpawn registers synchronously and disallows further ordinary launches after the gate closes.
  shutdownPromise = (async () => {
    await Promise.allSettled([...pendingMxc]);
    const children = [...liveOwned];
    const results = await Promise.allSettled(children.map((child) => terminateProcess(child)));
    await mxcHelpers.shutdown();
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    const remaining = children.filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of remaining)
      failures.push(new Error(`Owned CLI process did not exit (PID ${child.pid ?? 'unknown'}).`));
    if (failures.length)
      throw Object.assign(new AggregateError(failures, 'Owned process cleanup did not complete.'), {
        ...(remaining.length ||
        failures.some((error) => (error as NodeJS.ErrnoException)?.code === 'owned-processes-still-running')
          ? { code: 'owned-processes-still-running' }
          : {}),
      });
  })();
  return shutdownPromise;
}

/** Metadata capture: a Windows pipe may stay open after its owning process has exited. */
export async function collectProcessOutput(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  acceptedExitCodes = [0],
): Promise<{ stdout: string; exitCode: number | null; diagnostic?: CliDiagnosticCode }> {
  return new Promise((resolveResult, reject) => {
    let stdout = '';
    const diagnostic = new CliDiagnosticCapture();
    let settled = false;
    let exited = child.exitCode !== null || child.signalCode !== null;
    let exitCode = child.exitCode;
    let drainTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      child.stdout.off('data', onData);
      child.stdout.off('end', onEnd);
      child.stderr.off('data', onDiagnostic);
      child.stderr.off('end', onEnd);
      child.off('exit', onExit);
      child.off('close', onClose);
      child.off('error', onError);
      // These streams belong only to this capture. Closing them also releases a lingering Windows pipe.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else if (code !== null && acceptedExitCodes.includes(code))
        resolveResult({ stdout, exitCode: code, ...(diagnostic.code ? { diagnostic: diagnostic.code } : {}) });
      else reject(new Error(diagnostic.code ?? 'runtime-process-closed'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(child.exitCode, new Error('runtime-timeout'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      if (stdout.length < 1_048_576) stdout += chunk.toString('utf8');
    };
    const onDiagnostic = (chunk: Buffer) => diagnostic.write(chunk.toString('utf8'));
    const onError = (error: Error) => finish(child.exitCode, error);
    const onClose = (code: number | null) => finish(code);
    const onEnd = () => {
      if (exited && child.stdout.readableEnded && child.stderr.readableEnded) finish(exitCode);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      if (child.stdout.readableEnded && child.stderr.readableEnded) finish(code);
      // Allow already-buffered output to drain, without waiting indefinitely for `close`.
      else drainTimer ??= setTimeout(() => finish(code), 250);
    };
    child.stdout.on('data', onData);
    child.stdout.once('end', onEnd);
    child.stderr.on('data', onDiagnostic);
    child.stderr.once('end', onEnd);
    child.once('error', onError);
    child.once('close', onClose);
    child.once('exit', onExit);
    child.stdin.end();
    if (exited) onExit(exitCode);
  });
}

export async function captureTarget(
  target: RuntimeTarget,
  args: string[],
  options: TargetSpawnOptions & { timeoutMs?: number; acceptedExitCodes?: number[] } = {},
): Promise<{ stdout: string; exitCode: number | null; diagnostic?: CliDiagnosticCode }> {
  const child = await spawnTarget(target, args, options);
  try {
    return await collectProcessOutput(child, options.timeoutMs ?? 10_000, options.acceptedExitCodes);
  } finally {
    await terminateProcess(child);
  }
}
