import '../server/platform/under-test.mjs';
import { fork, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isQuitInspection, type QuitInspection } from './lifecycle.ts';
import { APP_NAME, APP_VERSION } from '../shared/identity.ts';
import { terminateWindowsBackend, WINDOWS_BACKEND_CLEANUP_TIMEOUT_MS } from './backend-process.ts';
import { createWindowsBackendGuard, type BackendGuard } from './windows-backend-guard.ts';
import { createPosixBackendGuard } from './posix-backend-guard.ts';
import { backendCpuTime, sampleBackendCpu } from './backend-cpu.ts';
import type { PermissionChange } from '../shared/permission-change.ts';
import type { AccountBackendMessage, AccountMainMessage } from '../shared/account-ui.ts';

export type BackendReady = { type: 'ready'; name: typeof APP_NAME; version: string; port: number; dataDir: string };
export type BackendState = {
  phase: 'idle' | 'starting' | 'recovering' | 'ready' | 'error' | 'stopping' | 'stopped';
  message?: string;
};
type Options = {
  root: string;
  dataDir: string;
  port: number;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  launch?: (env: NodeJS.ProcessEnv) => ChildProcess;
  terminate?: (child: ChildProcess) => Promise<void>;
  guard?: (child: ChildProcess) => BackendGuard;
  startupMs?: number;
  inspectionMs?: number;
  shutdownMs?: number;
  killMs?: number;
  /** Stop when consecutive failures reach this limit; zero disables recovery. */
  restartLimit?: number;
  restartStableMs?: number;
  log?: (line: string) => void;
  restartBackoffMs?: number;
  healthFetch?: typeof fetch;
  cpuTime?: (pid: number) => Promise<string>;
  changed?: (state: BackendState) => void;
  crashed?: (reason: 'abnormal-exit') => void;
  /** Runs a page test the server asked for (test_page); the desktop app owns the browser. */
  pageTest?: (request: unknown) => Promise<unknown>;
  /** Drives a web agent's window for the server (src/electron/web-bridge.ts). */
  webAgent?: (request: unknown) => Promise<unknown>;
  accountMessage?: (message: AccountBackendMessage) => void;
};
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only call with the still-live ChildProcess this instance launched; never search or kill by name. */
export async function terminateOwnedBackend(child: ChildProcess, budgetMs?: number): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') return terminateWindowsBackend(child, undefined, budgetMs);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Owns exactly one child; matching HTTP health responses never establish ownership. */
export class OwnedBackend {
  state: BackendState = { phase: 'idle' };
  private sessionToken?: string;
  private sessionOwner?: string;
  get owner() {
    return this.sessionOwner;
  }
  get token() {
    return this.sessionToken;
  }
  private child?: ChildProcess;
  private started?: Promise<BackendReady>;
  private stopping?: Promise<void>;
  private readyResolve?: (ready: BackendReady) => void;
  private readyReject?: (error: Error) => void;
  private exited = false;
  private acknowledged = false;
  private exitCode: number | null = null;
  private forced = false;
  private cleanupPending = false;
  private failureCleanup?: Promise<void>;
  private exitPromise: Promise<void>;
  private exitResolve!: () => void;
  private sequence = 0;
  private generation = 0;
  private guard?: BackendGuard;
  private guardReady = false;
  private everReady = false;
  private intentionalStop = false;
  private recoveryBlocked = false;
  private restartTimer?: NodeJS.Timeout;
  private launchedOnce = false;
  private consecutiveFailures = 0;
  private stableTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private healthRequest?: AbortController;
  private healthFailures = 0;
  private healthLastTick = 0;
  private healthSince = 0;
  private healthSuspended = false;
  private hung = false;
  private recoveryReady?: {
    promise: Promise<BackendReady>;
    resolve: (ready: BackendReady) => void;
    reject: (error: Error) => void;
  };
  private inspections = new Map<number, { resolve: (value: QuitInspection) => void; reject: (error: Error) => void }>();
  private permissionRequests = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  async changePermission(change: PermissionChange, apply: boolean, expected?: string): Promise<string> {
    const child = this.child;
    if (!child?.connected || this.state.phase !== 'ready') throw new Error('本地后台不可用。');
    const requestId = ++this.sequence;
    try {
      return await bounded(
        new Promise<string>((resolve, reject) => {
          this.permissionRequests.set(requestId, { resolve, reject });
          child.send({ type: 'permission-change', requestId, change, apply, expected }, (error) => {
            if (error) reject(error);
          });
        }),
        10000,
        '权限修改未确认，请检查当前状态。',
      );
    } finally {
      this.permissionRequests.delete(requestId);
    }
  }
  constructor(private readonly options: Options) {
    this.exitPromise = new Promise((done) => {
      this.exitResolve = done;
    });
  }
  get pid() {
    return this.child?.pid;
  }
  /** Parent/child IPC only: this is deliberately absent from the preload API. */
  sendAccount(message: AccountMainMessage) {
    const child = this.child;
    if (this.state.phase !== 'ready' || !child?.connected || this.exited) return;
    child.send(message, () => {});
  }
  private update(phase: BackendState['phase'], message?: string) {
    this.state = { phase, ...(message ? { message } : {}) };
    try {
      this.options.changed?.(this.state);
    } catch (error) {
      this.logShutdown(`changed callback threw: ${String(error)}`);
    }
  }
  private logShutdown(message: string, generation = this.generation, pid = this.pid) {
    try {
      const line = `${new Date().toISOString()} generation=${generation} pid=${pid ?? '?'} phase=${this.state.phase} attempt=${this.consecutiveFailures} reason=${message.replace(/[\r\n]/g, ' ')}`;
      this.options.log?.(line);
      if (this.options.launch) return;
      const directory = join(this.options.dataDir, 'logs');
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, 'desktop.log'), `${line}\n`);
    } catch {
      /* Diagnostics must not hold the application's exit open. */
    }
  }
  start(): Promise<BackendReady> {
    if (this.intentionalStop || this.state.phase === 'stopping' || this.state.phase === 'stopped')
      return Promise.reject(new Error('后台已关闭，不能重新启动。'));
    if (this.state.phase === 'error') return Promise.reject(new Error(this.state.message || '后台服务不可用。'));
    if (this.recoveryReady) return this.recoveryReady.promise;
    if (this.started) return this.started;
    return this.launch(false);
  }
  private launch(recovering: boolean): Promise<BackendReady> {
    if (recovering) this.logShutdown('relaunch starting');
    this.clearHealth();
    this.hung = false;
    const generation = ++this.generation;
    const guarded = Boolean(this.options.guard || !this.options.launch);
    this.guard = undefined;
    this.guardReady = !guarded;
    this.exited = false;
    this.acknowledged = false;
    this.exitCode = null;
    this.forced = false;
    this.cleanupPending = false;
    this.failureCleanup = undefined;
    this.recoveryBlocked = false;
    this.exitPromise = new Promise((done) => {
      this.exitResolve = done;
    });
    this.update(recovering ? 'recovering' : 'starting', recovering ? this.state.message : undefined);
    const readiness = new Promise<BackendReady>((done, reject) => {
      this.readyResolve = done;
      this.readyReject = reject;
    });
    this.started = bounded(
      readiness,
      this.options.startupMs ?? (guarded ? 40000 : 20000),
      '后台启动超时；请检查端口及数据目录。',
    ).catch((error) => {
      // An old attempt's rejected readiness must not replace a newer recovery state.
      if (generation === this.generation && !this.exited && !this.intentionalStop)
        this.fail(error instanceof Error ? error.message : '后台启动失败。');
      throw error;
    });
    try {
      const env: NodeJS.ProcessEnv = {
        ...(this.options.env ?? process.env),
        ELECTRON_RUN_AS_NODE: '1',
        PUGPORT_PURGE_INCOGNITO: this.launchedOnce ? '0' : '1',
        COMBORUNNER_ROOT: this.options.root,
        AGENT_STUDIO_ROOT: this.options.root,
        COMBORUNNER_DATA_DIR: this.options.dataDir,
        AGENT_STUDIO_DATA_DIR: this.options.dataDir,
        COMBORUNNER_PORT: String(this.options.port),
        AGENT_STUDIO_PORT: String(this.options.port),
        ...(guarded ? { PUGPORT_BACKEND_GUARD: process.platform === 'win32' ? 'windows-job' : 'posix-groups' } : {}),
        ...(this.options.webAgent ? { PUGPORT_WEB_BRIDGE: '1' } : {}),
      };
      const child = (this.child =
        this.options.launch?.(env) ??
        fork(join(this.options.root, 'dist', 'server', guarded ? 'bootstrap.js' : 'main.js'), [], {
          execPath: this.options.execPath ?? process.execPath,
          env,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        }));
      this.launchedOnce = true;
      // What the backend prints goes to a log, so a crash leaves its last words behind.
      const log = this.options.launch ? undefined : this.openLog();
      if (log) {
        log.write(`
=== ${new Date().toISOString()} ${APP_NAME} ${APP_VERSION} backend pid ${this.child.pid ?? '?'} ===
`);
        this.child.stdout?.pipe(log, { end: false });
        this.child.stderr?.pipe(log, { end: false });
        this.child.once('exit', (code, signal) => {
          log.end(`=== exited code=${code ?? ''} signal=${signal ?? ''} at ${new Date().toISOString()} ===
`);
        });
      } else {
        this.child.stdout?.resume();
        this.child.stderr?.resume();
      }
      child.on('message', (value) => {
        if (this.child === child && generation === this.generation && !this.exited) this.message(value, child);
      });
      child.once('error', () => {
        if (this.child === child && generation === this.generation && !this.exited) this.fail('无法启动本地后台进程。');
      });
      child.once('exit', (code, signal) => this.exit(child, generation, code, signal));
      // A spawn failure can close without an exit event.
      child.once('close', (code, signal) => this.exit(child, generation, code, signal));
      if (guarded) {
        const guard = (this.guard =
          this.options.guard?.(child) ??
          (process.platform === 'win32' ? createWindowsBackendGuard(child) : createPosixBackendGuard(child)));
        void guard.ready
          .then(() => {
            if (this.child === child && this.generation === generation && !this.intentionalStop && !this.exited)
              this.guardReady = true;
          })
          .catch(() => {
            if (this.child === child && this.generation === generation && !this.intentionalStop)
              this.fail('后台进程保护未就绪，本次未加载服务。');
          });
        // A missing guardian kills its job. Never replace it without its complete
        // zero-active-process cleanup acknowledgement.
        void guard.closed.catch((error: unknown) => {
          this.logShutdown(`guardian closed failed: ${String(error)}`, generation, child.pid);
          if (this.child === child && this.generation === generation && !this.intentionalStop)
            this.fail('后台进程保护或子进程清理未完成，本次不会自动恢复。');
        });
      }
    } catch {
      this.exited = true;
      this.exitResolve();
      this.fail('无法启动本地后台进程。');
    }
    return this.started;
  }
  /** dataDir/logs/backend.log, started afresh (the previous one kept as .old) once it passes 2 MB. */
  private openLog(): WriteStream | undefined {
    try {
      const folder = join(this.options.dataDir, 'logs');
      mkdirSync(folder, { recursive: true });
      const file = join(folder, 'backend.log');
      try {
        if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, join(folder, 'backend.old.log'));
      } catch {
        /* No log yet. */
      }
      const stream = createWriteStream(file, { flags: 'a' });
      stream.on('error', () => undefined);
      return stream;
    } catch {
      return undefined;
    }
  }
  private message(value: unknown, child: ChildProcess) {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    if (this.state.phase === 'ready' && (message.type === 'account-action' || message.type === 'account-persist-key')) {
      this.options.accountMessage?.(message as AccountBackendMessage);
      return;
    }
    if (message.type === 'session' && typeof message.token === 'string') {
      this.sessionToken = message.token;
      this.sessionOwner = typeof message.owner === 'string' ? message.owner : undefined;
      return;
    }
    if (message.type === 'permission-change-result' && typeof message.requestId === 'number') {
      const request = this.permissionRequests.get(message.requestId);
      if (typeof message.description === 'string') request?.resolve(message.description);
      else request?.reject(new Error(String(message.error ?? '权限修改失败。')));
      return;
    }
    if (message.type === 'ready') {
      if (this.state.phase !== 'starting' && this.state.phase !== 'recovering') return;
      if (!this.guardReady) {
        this.fail('后台服务在进程保护就绪之前报告启动，未接受握手。');
        return;
      }
      if (
        message.name !== APP_NAME ||
        message.version !== APP_VERSION ||
        message.port !== this.options.port ||
        typeof message.dataDir !== 'string' ||
        !samePath(message.dataDir, this.options.dataDir)
      ) {
        this.fail('后台握手不匹配，未连接到该服务。');
        return;
      }
      this.update('ready');
      this.startHealth();
      this.everReady = true;
      const generation = this.generation;
      this.stableTimer = setTimeout(
        () => {
          if (this.child !== child || this.generation !== generation || this.state.phase !== 'ready' || this.exited)
            return;
          this.logShutdown('stable ready period completed; reset consecutive failures');
          this.consecutiveFailures = 0;
        },
        Math.max(1, this.options.restartStableMs ?? 60000),
      ).unref();
      this.readyResolve?.(message as BackendReady);
      this.readyResolve = undefined;
      this.readyReject = undefined;
      this.recoveryReady?.resolve(message as BackendReady);
      this.recoveryReady = undefined;
    } else if (message.type === 'shutdown-complete') {
      if (this.state.phase === 'stopping') this.acknowledged = true;
    } else if (message.type === 'quit-inspection' && typeof message.requestId === 'number') {
      const request = this.inspections.get(message.requestId);
      if (!request) return;
      this.inspections.delete(message.requestId);
      if (!message.error && isQuitInspection(message)) request.resolve(message);
      else request.reject(new Error('后台无法确认任务状态。'));
    } else if (message.type === 'page-test' && typeof message.requestId === 'number') {
      const requestId = message.requestId;
      const reply = (result: unknown) =>
        this.child === child &&
        !this.exited &&
        child.connected &&
        child.send({ type: 'page-test-result', requestId, result });
      if (!this.options.pageTest)
        reply({ steps: [], screenshots: [], consoleErrors: [], title: '', error: '桌面版没有提供页面测试。' });
      else
        void this.options
          .pageTest(message.request)
          .then(reply)
          .catch((error: unknown) =>
            reply({
              steps: [],
              screenshots: [],
              consoleErrors: [],
              title: '',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
    } else if (message.type === 'web-agent' && typeof message.requestId === 'number') {
      const requestId = message.requestId;
      const reply = (result: unknown) =>
        this.child === child &&
        !this.exited &&
        child.connected &&
        child.send({ type: 'web-agent-result', requestId, result });
      if (!this.options.webAgent) reply({ ok: false, code: 'unavailable', message: '这个桌面版没有提供网页智能体。' });
      else
        void this.options
          .webAgent(message.request)
          .then(reply)
          .catch((error: unknown) =>
            reply({ ok: false, code: 'error', message: error instanceof Error ? error.message : String(error) }),
          );
    } else if (message.type === 'error' || message.type === 'fatal')
      this.fail('后台服务报告错误；请检查端口或数据目录是否正被占用。');
  }
  private fail(message: string) {
    this.logShutdown(`fail: ${message}`);
    clearTimeout(this.stableTimer);
    clearTimeout(this.restartTimer);
    this.clearHealth();
    // Fatal startup/identity/port failures are not transient process crashes.
    this.recoveryBlocked = true;
    const error = new Error(message);
    this.readyReject?.(error);
    this.readyReject = undefined;
    for (const request of this.inspections.values()) request.reject(error);
    this.inspections.clear();
    this.recoveryReady?.reject(error);
    this.recoveryReady = undefined;
    if (this.state.phase !== 'stopping' && this.state.phase !== 'stopped') this.update('error', message);
    this.cleanupFailure();
  }
  private cleanupFailure() {
    const child = this.child;
    const guard = this.guard;
    if (!child || this.failureCleanup || (this.exited && !guard && !this.cleanupPending)) return;
    const generation = this.generation;
    this.cleanupPending = true;
    this.forced = true;
    // Recovery startup has no outer main.start() rejection handler. A timeout or
    // rejected identity must stop this exact replacement instead of leaving an
    // error-labelled server processing tasks in the background.
    this.failureCleanup = Promise.resolve()
      .then(() => this.terminateChild(child, guard))
      .then(() => {
        if (this.child === child && this.generation === generation) this.cleanupPending = false;
      });
    void this.failureCleanup.catch((error: unknown) => {
      if (this.child !== child || this.generation !== generation || this.intentionalStop) return;
      this.logShutdown(error instanceof Error ? error.message : '启动失败后的后台清理未完成。');
      // Keep cleanupPending so an explicit stop retries bounded ownership cleanup.
    });
  }
  private exit(child: ChildProcess, generation: number, code: number | null, signal: NodeJS.Signals | null) {
    if (this.child !== child || generation !== this.generation || this.exited) {
      this.logShutdown(
        `exit skipped recovery: ${this.child !== child ? 'stale child' : generation !== this.generation ? 'stale generation' : 'already exited'}`,
        generation,
        child.pid,
      );
      return;
    }
    clearTimeout(this.stableTimer);
    this.sessionToken = undefined;
    this.sessionOwner = undefined;
    this.clearHealth();
    this.exited = true;
    this.exitCode = code;
    this.exitResolve();
    if (this.intentionalStop || this.state.phase === 'stopping' || this.state.phase === 'stopped') {
      this.logShutdown('exit skipped recovery: intentional stop');
      return;
    }
    if (this.everReady) this.consecutiveFailures++;
    this.logShutdown(
      `exit eligibility eligible=${this.everReady && !this.recoveryBlocked} everReady=${this.everReady} recoveryBlocked=${this.recoveryBlocked} code=${code} signal=${signal}`,
    );
    const message = `后台服务已退出（${signal ?? code ?? '未知状态'}）；未连接其他服务。`;
    const error = new Error(message);
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const request of this.inspections.values()) request.reject(error);
    this.inspections.clear();
    if (this.everReady && !this.recoveryBlocked) this.scheduleRecovery(message);
    else this.fail(this.recoveryBlocked ? this.state.message || message : message);
  }
  private scheduleRecovery(message: string) {
    const limit = Math.max(0, this.options.restartLimit ?? 3);
    this.logShutdown(`recovery limit check limit=${limit} allowed=${this.consecutiveFailures < limit}`);
    if (this.consecutiveFailures >= limit) {
      this.options.crashed?.('abnormal-exit');
      this.fail(`PugPort 后台服务在 ${limit} 次重启失败后已停止。请打开日志文件夹，然后重新打开 PugPort。`);
      return;
    }
    const attempt = this.consecutiveFailures;
    const delay = Math.min(10000, Math.max(1, this.options.restartBackoffMs ?? 1000) * 2 ** (attempt - 1));
    if (!this.recoveryReady) {
      let resolve!: (ready: BackendReady) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<BackendReady>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      // Automatic recovery does not require a caller to observe this readiness promise.
      void promise.catch(() => {});
      this.recoveryReady = { promise, resolve, reject };
    }
    this.started = undefined;
    this.logShutdown(`unexpected exit; recovery attempt=${attempt} delayMs=${delay}; ${message}`);
    this.update('recovering', `本地后台意外退出，正在自动恢复（第 ${attempt} 次）。`);
    const generation = this.generation;
    const schedule = () => {
      if (this.intentionalStop || generation !== this.generation || this.state.phase !== 'recovering') {
        this.logShutdown('recovery scheduling cancelled', generation);
        return;
      }
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.logShutdown('recovery timer fired', generation);
        if (this.intentionalStop || generation !== this.generation || this.state.phase !== 'recovering') {
          this.logShutdown('recovery timer cancelled', generation);
          return;
        }
        void this.launch(true).catch(() => {});
      }, delay);
    };
    const pid = this.pid;
    this.logShutdown('cleanup wait starting');
    if (this.guard || this.failureCleanup) {
      this.cleanupPending = true;
      void bounded(
        Promise.all([this.guard?.closed, this.failureCleanup]),
        this.failureCleanup ? 10000 + (this.options.killMs ?? WINDOWS_BACKEND_CLEANUP_TIMEOUT_MS) : 10000,
        '旧后台子进程清理确认超时。',
      )
        .then(() => {
          this.logShutdown('cleanup wait succeeded', generation, pid);
          if (generation !== this.generation) return;
          this.cleanupPending = false;
          schedule();
        })
        .catch((error: unknown) => {
          this.logShutdown(`cleanup wait failed: ${String(error)}`, generation, pid);
          if (generation === this.generation && !this.intentionalStop)
            this.fail('旧后台子进程清理未确认，本次不会自动恢复。');
        });
    } else {
      this.logShutdown('cleanup wait succeeded: child exited, no guardian or termination pending');
      schedule();
    }
  }

  private clearHealth() {
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.healthRequest?.abort();
    this.healthRequest = undefined;
    this.healthFailures = 0;
  }
  /** Sleep/resume notifications invalidate even a probe already in flight. */
  suspendHealth() {
    this.healthSuspended = true;
    if (!this.failureCleanup) this.hung = false;
    this.clearHealth();
  }
  resumeHealth() {
    this.healthSuspended = false;
    if (!this.failureCleanup) this.hung = false;
    this.startHealth();
  }
  private startHealth() {
    this.clearHealth();
    if (
      this.state.phase !== 'ready' ||
      this.healthSuspended ||
      this.hung ||
      this.intentionalStop ||
      this.cleanupPending
    )
      return;
    this.healthLastTick = Date.now();
    this.healthSince = this.healthLastTick;
    this.healthTimer = setInterval(() => void this.pingHealth(), 15_000).unref();
  }
  private async pingHealth() {
    const child = this.child;
    const generation = this.generation;
    try {
      if (child && (child.exitCode !== null || child.signalCode !== null) && !this.exited)
        this.exit(child, generation, child.exitCode, child.signalCode);
      await this.checkHealth();
    } catch (error) {
      this.healthError('pingHealth', error, child, generation);
    }
  }
  private healthError(reason: string, error: unknown, child: ChildProcess | undefined, generation: number) {
    this.logShutdown(`${reason} failed: ${String(error)}`, generation, child?.pid);
    if (!child || this.child !== child || this.generation !== generation || this.intentionalStop) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.exit(child, generation, child.exitCode, child.signalCode);
    } else if (!this.failureCleanup && this.state.phase === 'ready') {
      this.hung = false;
      this.startHealth();
    }
  }
  private async checkHealth() {
    const child = this.child;
    if (
      this.state.phase !== 'ready' ||
      this.healthSuspended ||
      this.intentionalStop ||
      this.hung ||
      this.cleanupPending ||
      !child ||
      this.exited ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const now = Date.now();
    const jump = now - this.healthLastTick;
    this.healthLastTick = now;
    if (jump > 60_000 || jump < 0) {
      this.startHealth();
      return;
    }
    if (this.healthRequest) return;
    const request = (this.healthRequest = new AbortController());
    let timer: NodeJS.Timeout | undefined;
    let ok = false;
    try {
      // Race as well as abort: even a transport which ignores abort cannot stall the watchdog.
      ok = await Promise.race([
        (this.options.healthFetch ?? fetch)(`http://127.0.0.1:${this.options.port}/api/health`, {
          signal: request.signal,
          redirect: 'error',
        }).then(async (response) => {
          const body = (await response.json()) as { ok?: boolean; name?: string; version?: string };
          return response.ok && body.ok === true && body.name === APP_NAME && body.version === APP_VERSION;
        }),
        new Promise<false>((done) => {
          timer = setTimeout(() => {
            request.abort();
            done(false);
          }, 5000);
        }),
      ]);
    } catch {
      /* Count failed HTTP and body reads alike. */
    } finally {
      clearTimeout(timer);
    }
    if (this.healthRequest !== request || this.child !== child || this.exited || this.state.phase !== 'ready') return;
    this.healthRequest = undefined;
    // A suspended machine may resume in the middle of a timed-out request.
    if (Date.now() - now > 60_000 || Date.now() < now) {
      this.startHealth();
      return;
    }
    if (ok) {
      this.healthFailures = 0;
      this.healthSince = Date.now();
      return;
    }
    if (++this.healthFailures < 8) return;
    this.hung = true;
    this.clearHealth();
    const generation = this.generation;
    await this.handleHang(child, generation, now).catch((error: unknown) =>
      this.healthError('hang', error, child, generation),
    );
  }
  private async handleHang(child: ChildProcess, generation: number, now: number) {
    const guard = this.guard;
    const stillOwned = () =>
      this.child === child &&
      generation === this.generation &&
      !this.exited &&
      !this.intentionalStop &&
      !this.healthSuspended &&
      this.hung;
    const cpu = await sampleBackendCpu(child.pid!, async (pid) =>
      stillOwned()
        ? bounded((this.options.cpuTime ?? backendCpuTime)(pid), 3500, 'CPU query timeout').catch(() => 'unavailable')
        : 'unavailable',
    );
    if (!stillOwned()) return;
    if (Date.now() - now > 60_000 || Date.now() < now) {
      this.hung = false;
      this.startHealth();
      return;
    }
    try {
      const directory = join(this.options.dataDir, 'logs');
      mkdirSync(directory, { recursive: true });
      let busy: unknown = 'unavailable';
      try {
        const file = join(directory, 'backend-busy.json');
        if (statSync(file).size <= 16_384) busy = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* Missing/partial breadcrumbs must not prevent recovery. */
      }
      appendFileSync(
        join(directory, 'backend.log'),
        `[hang] backend unresponsive ${Math.round((Date.now() - this.healthSince) / 1000)}s, pid=${child.pid}, cpu=${cpu}, busy=${JSON.stringify(busy)}\n`,
      );
    } catch {
      /* Recovery must work even if logging fails. */
    }
    this.forced = true;
    this.cleanupPending = true;
    const exited = this.exitPromise;
    this.failureCleanup = Promise.resolve()
      .then(() => this.terminateChild(child, guard))
      .then(async () => {
        await bounded(exited, this.options.killMs ?? 5000, '自有后台进程仍未停止。');
        if (this.child === child && generation === this.generation) this.cleanupPending = false;
      });
    void this.failureCleanup.catch((error: unknown) => {
      this.logShutdown(`hang cleanup failed: ${String(error)}`, generation, child.pid);
      if (generation === this.generation && !this.intentionalStop)
        this.fail('旧后台子进程清理未确认，本次不会自动恢复。');
    });
  }
  inspect(): Promise<QuitInspection> {
    if (!this.child?.connected || this.exited || this.state.phase !== 'ready')
      return Promise.reject(new Error('后台服务尚未就绪。'));
    const id = ++this.sequence;
    const reply = new Promise<QuitInspection>((done, reject) => {
      this.inspections.set(id, { resolve: done, reject });
      this.child!.send({ type: 'quit-inspection', requestId: id }, (error) => {
        if (error) {
          this.inspections.delete(id);
          reject(new Error('无法询问后台任务状态。'));
        }
      });
    });
    return bounded(reply, this.options.inspectionMs ?? 2000, '后台任务检查超时。').finally(() => {
      this.inspections.delete(id);
    });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    clearTimeout(this.stableTimer);
    this.clearHealth();
    this.intentionalStop = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.recoveryReady?.reject(new Error('后台恢复已取消。'));
    this.recoveryReady = undefined;
    this.stopping = this.stopChild().catch((error) => {
      this.stopping = undefined;
      this.update('error', error instanceof Error ? error.message : '后台停止失败。');
      this.logShutdown(this.state.message!);
      throw error;
    });
    return this.stopping;
  }
  private terminateChild(child: ChildProcess, guard = this.guard) {
    if (guard) return guard.terminate();
    const killMs = this.options.killMs ?? WINDOWS_BACKEND_CLEANUP_TIMEOUT_MS;
    // The native helper must stop initiating work before the outer UI timeout,
    // including callers that explicitly configure a shorter cleanup deadline.
    const budgetMs = Math.max(1, killMs - Math.min(2000, killMs / 10));
    return bounded(
      this.options.terminate ? this.options.terminate(child) : terminateOwnedBackend(child, budgetMs),
      killMs,
      '终止后台进程树超时。',
    );
  }
  private async stopChild() {
    this.sessionToken = undefined;
    this.sessionOwner = undefined;
    this.update('stopping');
    this.readyReject?.(new Error('后台启动已取消。'));
    this.readyReject = undefined;
    for (const request of this.inspections.values()) request.reject(new Error('后台正在退出。'));
    this.inspections.clear();
    const child = this.child;
    this.logShutdown('request shutdown');
    // Coalesce with failure cleanup, then retry below if that cleanup failed.
    if (this.failureCleanup) await this.failureCleanup.catch(() => {});
    if (this.guard && !this.guardReady) {
      // A blocked bootstrap has no service to answer graceful shutdown. Wait
      // for its original handle and the guardian instead of an unavailable IPC.
      await this.guard.terminate();
    }
    // A previous attempt may have stopped the root but left a verified descendant alive.
    // Retry that cleanup instead of treating the root's later exit as success by itself.
    if (child && this.cleanupPending) {
      await this.terminateChild(child);
      this.cleanupPending = false;
    }
    if (child && !this.exited) {
      if (child.connected) {
        try {
          child.send({ type: 'shutdown' }, () => {});
        } catch {
          /* Continue to bounded ownership cleanup. */
        }
      }
      try {
        await bounded(this.exitPromise, this.options.shutdownMs ?? 10000, '等待后台关闭超时。');
      } catch {
        if (!this.exited) {
          this.forced = true;
          this.cleanupPending = true;
          this.logShutdown('graceful shutdown timed out; inspect and terminate owned tree');
          await this.terminateChild(child);
          this.cleanupPending = false;
        }
        await bounded(this.exitPromise, this.options.killMs ?? 5000, '自有后台进程仍未停止。');
      }
    }
    if (this.guard) {
      await bounded(this.guard.closed, 10000, '后台子进程清理确认超时。').catch(async () => {
        this.forced = true;
        await this.guard!.terminate();
      });
      this.cleanupPending = false;
    }
    this.update(
      'stopped',
      child && (!this.acknowledged || this.exitCode !== 0 || this.forced)
        ? '后台已停止；未收到完整清理确认，请下次检查任务结果。'
        : undefined,
    );
    this.logShutdown(this.state.message || 'shutdown complete');
  }
}
