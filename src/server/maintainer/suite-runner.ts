import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { execFile, spawn, type ExecFileOptions } from '../platform/test-process.ts';
import { windowsTreeKill } from '../adapters/process.ts';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';
import type { WorkspaceStore } from '../workspace-store.ts';
import type { DesktopMaintainerConfig } from './config.ts';
import { createOwnerGh, type Gh } from './gh.ts';
import { collaboratorPermission } from './tiers.ts';
import type { AuditLine } from './audit.ts';

export type SuiteRequest = {
  cardId: string;
  number: number;
  sha: string;
  author: string;
  external: boolean;
};
export type SuiteResult = {
  sha: string;
  tests: number;
  passed: number;
  failed: number;
  failingFiles: string[];
  minutes: number;
  runId: string;
  status: 'passed' | 'failed' | 'error';
  detail?: string;
};
type Refusal = 'no-config' | 'same-sha' | 'daily-cap' | 'running' | 'untrusted';
type Permission = { ok: true } | { ok: false; reason: Refusal };
type Output = { code: number; stdout: string; stderr: string; error?: string };
type SuiteRecord = { startedAt: string; result?: SuiteResult; stdout?: string; stderr?: string };
type Deps = {
  config: () => Promise<DesktopMaintainerConfig | undefined>;
  store: Pick<WorkspaceStore, 'get' | 'save'>;
  git?: (cwd: string, args: string[], options: ExecFileOptions) => Promise<Output>;
  exec?: typeof execFile;
  spawn?: typeof spawn;
  ownerGh?: Gh;
  audit: (line: AuditLine) => void;
  now?: () => number;
};
const stdoutLimit = 4 * 1024 * 1024,
  stderrLimit = 64 * 1024;
const reportSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    tests: z.number().int().positive(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failingFiles: z.array(z.string().max(200)).max(50).default([]),
    minutes: z.number().nonnegative().optional(),
  })
  .refine((report) => report.passed + report.failed <= report.tests);
// Scan balanced objects, respecting braces in strings, so trailing log lines are harmless.
function lastReport(text: string) {
  const starts: number[] = [];
  let quoted = false,
    escaped = false;
  let last: unknown;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!starts.length) {
      if (c === '{') {
        starts.push(i);
        quoted = false;
        escaped = false;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') starts.push(i);
    else if (c === '}') {
      const start = starts.pop()!;
      try {
        last = JSON.parse(text.slice(start, i + 1));
      } catch {
        /* A log fragment is not JSON. */
      }
    }
  }
  return reportSchema.safeParse(last);
}
function clean(value: string, limit: number) {
  return redactToolDiagnostic(value.replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)/g, '[redacted]'), limit);
}
export class FullSuiteRunner {
  private active?: string;
  private readonly now: () => number;
  private readonly ownerGh: Gh;
  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.ownerGh = deps.ownerGh ?? createOwnerGh({ tmpRoot: tmpdir(), exec: deps.exec });
  }
  private date() {
    const date = new Date(this.now());
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
  today() {
    return this.deps.store.get<{ count: number }>('maintainer-suite-day', this.date())?.count ?? 0;
  }
  running() {
    return this.active;
  }
  private check(request: SuiteRequest): Permission {
    if (request.external !== false) return { ok: false, reason: 'untrusted' };
    if (this.active) return { ok: false, reason: 'running' };
    const result = this.deps.store.get<SuiteRecord>('maintainer-suite', request.sha)?.result;
    if (result?.status === 'passed' || result?.status === 'failed') return { ok: false, reason: 'same-sha' };
    if (this.today() >= 6) return { ok: false, reason: 'daily-cap' };
    return { ok: true };
  }
  async canRun(request: SuiteRequest): Promise<Permission> {
    const check = this.check(request);
    if (!check.ok) return check;
    if (!(await this.deps.config())?.fullSuite) return { ok: false, reason: 'no-config' };
    return this.check(request);
  }
  async run(request: SuiteRequest, signal?: AbortSignal, started?: () => Promise<void>): Promise<SuiteResult> {
    const check = this.check(request);
    if (!check.ok) throw new Error(check.reason);
    if (!Number.isSafeInteger(request.number) || request.number <= 0 || !/^[0-9a-f]{40}$/.test(request.sha))
      throw new Error('invalid request');
    this.active = request.sha;
    try {
      const config = await this.deps.config();
      if (!config?.fullSuite) throw new Error('no-config');
      if (signal?.aborted) throw new Error('aborted');
      const permission = await collaboratorPermission(
        (args) => this.ownerGh.text(args, { signal }),
        config.repository,
        request.author,
      );
      if (!permission.trusted) throw new Error('untrusted');
      if (signal?.aborted) throw new Error('aborted');
      const start = this.now(),
        runId = randomUUID();
      const record: SuiteRecord = { startedAt: new Date(start).toISOString() };
      this.deps.store.save('maintainer-suite-day', this.date(), 'maintainer', { count: this.today() + 1 });
      this.deps.store.save('maintainer-suite', request.sha, 'maintainer', record);
      let output: Output = { code: -1, stdout: '', stderr: '' };
      let result: SuiteResult = {
        sha: request.sha,
        tests: 0,
        passed: 0,
        failed: 0,
        failingFiles: [],
        minutes: 0,
        runId,
        status: 'error',
      };
      try {
        await started?.();
        const options: ExecFileOptions = {
          cwd: config.fullSuite.cwd,
          windowsHide: true,
          shell: false,
          env: this.environment(),
          signal,
        };
        const git = (args: string[]) =>
          this.deps.git
            ? this.deps.git(config.fullSuite!.cwd, args, options)
            : this.execute('git', args, options, 60_000, signal);
        const ref = `refs/pugport/maintainer/pr-${request.number}`;
        output = await git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/pull/${request.number}/head:${ref}`]);
        if (output.error || output.code !== 0) throw new Error(output.error ?? (output.stderr || 'git fetch failed'));
        if (signal?.aborted) throw new Error('aborted');
        output = await git(['rev-parse', ref]);
        if (output.error || output.code !== 0)
          throw new Error(output.error ?? (output.stderr || 'git rev-parse failed'));
        if (output.stdout.trim() !== request.sha) throw new Error('head moved');
        if (signal?.aborted) throw new Error('aborted');
        const argv = config.fullSuite.argv.map((arg) => (arg === '{sha}' ? request.sha : arg));
        output = await this.execute(
          argv[0],
          argv.slice(1),
          options,
          (config.fullSuite.timeoutMinutes ?? 120) * 60_000,
          signal,
        );
        if (output.error || output.code !== 0)
          throw new Error(output.error ?? `exit ${output.code}: ${output.stderr.slice(-900)}`);
        const report = lastReport(output.stdout);
        if (!report.success || report.data.sha !== request.sha) throw new Error('no valid suite JSON');
        result = {
          ...result,
          ...report.data,
          failingFiles: report.data.failingFiles.map((file) => clean(file, 200)),
          minutes: report.data.minutes ?? (this.now() - start) / 60_000,
          status: report.data.failed > 0 ? 'failed' : 'passed',
        };
      } catch (error) {
        result.detail = clean(error instanceof Error ? error.message : String(error), 1000);
        result.minutes = Math.max(0, (this.now() - start) / 60_000);
      }
      this.deps.store.save('maintainer-suite', request.sha, 'maintainer', {
        ...record,
        result,
        stdout: clean(output.stdout, stdoutLimit),
        stderr: clean(output.stderr, stderrLimit),
      });
      this.deps.audit({
        at: new Date(this.now()).toISOString(),
        mode: 'live',
        event: 'suite',
        number: request.number,
        sha: request.sha,
        action: 'suite',
        credential: 'gh-desktop',
        result: result.status === 'error' ? 'error' : 'ok',
        detail: result.detail ?? result.status,
      });
      return result;
    } finally {
      this.active = undefined;
    }
  }
  private environment() {
    const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
    for (const key of [
      'PATH',
      'Path',
      'PATHEXT',
      'SystemRoot',
      'SYSTEMROOT',
      'ComSpec',
      'WINDIR',
      'HOME',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'TMPDIR',
      'USER',
      'USERNAME',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'SSH_AUTH_SOCK',
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    return env;
  }
  private execute(
    file: string,
    args: string[],
    options: ExecFileOptions,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Output> {
    if (signal?.aborted) return Promise.resolve({ code: -1, stdout: '', stderr: '', error: 'aborted' });
    return new Promise((resolve) => {
      const child = (this.deps.spawn ?? spawn)(file, args, {
        ...options,
        signal: undefined,
        detached: process.platform !== 'win32',
      });
      let stdout = Buffer.alloc(0),
        stderr = Buffer.alloc(0),
        stopping = false,
        done = false;
      const tail = (before: Buffer, chunk: Buffer | string, limit: number) =>
        Buffer.concat([before, Buffer.from(chunk)]).subarray(-limit);
      child.stdout?.on('data', (chunk) => {
        stdout = tail(stdout, chunk, stdoutLimit);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = tail(stderr, chunk, stderrLimit);
      });
      const finish = (code: number, error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString(), error });
      };
      const stop = async (reason: string) => {
        if (stopping || done) return;
        stopping = true;
        if (process.platform === 'win32' && child.pid) {
          const tree = windowsTreeKill(child.pid);
          await new Promise<void>((resolveKill) => {
            try {
              (this.deps.exec ?? execFile)(
                tree.file,
                tree.args,
                { windowsHide: true, shell: false, env: options.env, timeout: 3000 },
                () => resolveKill(),
              );
            } catch {
              resolveKill();
            }
          });
        } else if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Already exited: still attempt the direct child below. */
          }
        try {
          child.kill('SIGKILL');
        } catch {
          /* Already exited. */
        }
        finish(-1, reason);
      };
      const abort = () => {
        void stop('aborted');
      };
      const timer = setTimeout(() => {
        void stop('timed out');
      }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => {
        if (!stopping) finish(-1, error.message);
      });
      child.once('close', (code) => {
        if (!stopping) finish(code ?? -1);
      });
      child.stdin?.end();
      if (signal?.aborted) abort();
    });
  }
}
