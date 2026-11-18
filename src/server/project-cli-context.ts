import { hardenedSshOptions, shellQuote as quote, validateJobOptions } from './remote-job-scripts.ts';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Project } from '../shared/types.ts';
import type {
  ProjectCliContext,
  ProjectCliContextUpdate,
  ProjectQueryResult,
  ProjectSshQuery,
} from '../shared/project-cli-context.ts';
import { spawnTarget, terminateProcess, type TargetSpawnOptions } from './adapters/process.ts';
import { redactToolDiagnostic } from './tool-diagnostics.ts';
import type { WorkspaceStore } from './workspace-store.ts';

type MemoryBinding = { path: string; device: string; inode: string };
type SavedContext = ProjectCliContext & { memoryBinding?: MemoryBinding };
type Dependencies = {
  launch(args: string[], options: TargetSpawnOptions): Promise<ChildProcessWithoutNullStreams>;
  terminate(child: ChildProcessWithoutNullStreams): Promise<void>;
};
const kind = 'project-cli-context';
const outputLimit = 256 * 1024;
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? normalize(a).toLowerCase() === normalize(b).toLowerCase()
    : normalize(a) === normalize(b);
export const sanitized = (value: string) =>
  redactToolDiagnostic(
    value.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[redacted private key]',
    ),
    outputLimit,
  );
const defaults: Dependencies = {
  launch: (args, options) =>
    spawnTarget(
      {
        id: 'project-ssh-query',
        provider: 'codex',
        label: 'Project SSH query',
        command: 'ssh',
        environment: 'native',
        enabled: true,
      },
      args,
      { ...options, syncAccountConfig: false },
    ),
  terminate: terminateProcess,
};

function queries(value: unknown): ProjectSshQuery[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('最多可保存 20 个固定远程查询。');
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('远程查询配置无效。');
    const input = entry as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) =>
          !['name', 'host', 'argv', 'timeoutSeconds', 'params', 'push', 'cwd', 'background', 'readOnly'].includes(key),
      ) ||
      typeof input.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.name) ||
      typeof input.host !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.host) ||
      !Array.isArray(input.argv) ||
      !input.argv.length ||
      input.argv.length > 64 ||
      input.argv.some((arg) => typeof arg !== 'string' || arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg)) ||
      typeof input.argv[0] !== 'string' ||
      !input.argv[0] ||
      input.argv[0].startsWith('-') ||
      input.argv.reduce((length: number, arg: string) => length + arg.length, 0) > 16384 ||
      (input.timeoutSeconds !== undefined &&
        (!Number.isInteger(input.timeoutSeconds) ||
          Number(input.timeoutSeconds) < 1 ||
          Number(input.timeoutSeconds) > (input.background === true ? 14400 : 120)))
    )
      throw new Error(
        '远程查询需要有效名称、SSH 主机别名、固定参数和有效超时（普通查询 1 至 120 秒，后台作业 1 至 14400 秒）。',
      );
    if (names.has(input.name)) throw new Error('远程查询名称不能重复。');
    names.add(input.name);
    return {
      ...validateJobOptions(input),
      name: input.name,
      host: input.host,
      argv: [...input.argv] as string[],
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: Number(input.timeoutSeconds) }),
    };
  });
}

/** Configuration writes belong exclusively to authenticated user UI routes. Agents only list/run saved names. */
export class ProjectCliContextService {
  private active = new Map<string, AbortController>();
  private operations = new Set<Promise<unknown>>();
  private launches = new Set<Promise<unknown>>();
  private closing = false;
  private cleanupFailed = false;
  private shutdown?: Promise<void>;
  constructor(
    private readonly store: Pick<WorkspaceStore, 'get' | 'save'>,
    private readonly deps: Dependencies = defaults,
  ) {}
  private project(id: string) {
    const project = this.store.get<Project>('project', id);
    if (!project || project.removedAt || project.scope === 'chat') throw new Error('这个配置只适用于仍存在的项目。');
    return project;
  }
  get(projectId: string): ProjectCliContext {
    this.project(projectId);
    const saved = this.store.get<SavedContext>(kind, projectId);
    if (!saved) return { projectId, revision: 0, sshQueries: [] };
    if (saved.projectId !== projectId || !Number.isSafeInteger(saved.revision) || saved.revision < 1)
      throw new Error('项目上下文配置需要重新保存。');
    return {
      projectId,
      revision: saved.revision,
      ...(saved.autoMemoryDirectory ? { autoMemoryDirectory: saved.autoMemoryDirectory } : {}),
      sshQueries: queries(saved.sshQueries),
    };
  }
  async update(
    projectId: string,
    input: ProjectCliContextUpdate,
    actor: { source: 'user' },
  ): Promise<ProjectCliContext> {
    if (actor?.source !== 'user') throw new Error('只能由用户在项目设置中授权这个配置。');
    this.project(projectId);
    if (
      !input ||
      Object.keys(input).some((key) => !['revision', 'autoMemoryDirectory', 'sshQueries'].includes(key)) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0
    )
      throw new Error('项目上下文配置无效。');
    if (this.get(projectId).revision !== input.revision) throw new Error('配置已被其他窗口更新，请重新载入后再保存。');
    const sshQueries = queries(input.sshQueries);
    let memoryBinding: MemoryBinding | undefined;
    if (input.autoMemoryDirectory !== null) {
      if (
        typeof input.autoMemoryDirectory !== 'string' ||
        !isAbsolute(input.autoMemoryDirectory) ||
        input.autoMemoryDirectory.includes('\0')
      )
        throw new Error('请选择现有记忆文件夹的完整路径。');
      try {
        const path = await realpath(input.autoMemoryDirectory);
        const info = await stat(path, { bigint: true });
        if (!info.isDirectory()) throw new Error('not-directory');
        memoryBinding = { path, device: String(info.dev), inode: String(info.ino) };
      } catch {
        throw new Error('记忆文件夹不可用，请重新选择现有文件夹。');
      }
    }
    // Folder validation awaited filesystem IO; recheck both authorization scope and revision before saving.
    this.project(projectId);
    if (this.get(projectId).revision !== input.revision) throw new Error('配置已被其他窗口更新，请重新载入后再保存。');
    const saved: SavedContext = {
      projectId,
      revision: input.revision + 1,
      sshQueries,
      ...(memoryBinding ? { autoMemoryDirectory: memoryBinding.path, memoryBinding } : {}),
    };
    this.store.save(kind, projectId, projectId, saved);
    this.active.get(projectId)?.abort();
    return this.get(projectId);
  }
  async memoryDirectory(projectId: string): Promise<string | undefined> {
    const config = this.get(projectId);
    if (!config.autoMemoryDirectory) return;
    const saved = this.store.get<SavedContext>(kind, projectId)!;
    try {
      const binding = saved.memoryBinding;
      if (!binding || !samePath(binding.path, config.autoMemoryDirectory)) throw new Error('unbound');
      const path = await realpath(binding.path),
        info = await stat(path, { bigint: true });
      this.project(projectId);
      if (
        !samePath(path, binding.path) ||
        !info.isDirectory() ||
        String(info.dev) !== binding.device ||
        String(info.ino) !== binding.inode ||
        this.get(projectId).revision !== config.revision
      )
        throw new Error('changed');
      return path;
    } catch {
      throw new Error('已授权的记忆文件夹已移除或改变，请在项目设置中重新选择。');
    }
  }
  listQueries(projectId: string): ProjectSshQuery[] {
    return this.get(projectId).sshQueries;
  }
  runQuery(projectId: string, name: string, signal?: AbortSignal): Promise<ProjectQueryResult> {
    if (this.closing) return Promise.reject(new Error('应用正在关闭，不再启动远程查询。'));
    const operation = this.runQueryOnce(projectId, name, signal);
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    for (const controller of this.active.values()) controller.abort();
    this.shutdown = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.operations, ...this.launches]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('远程查询清理尚未完成；应用已停止接收新查询。')), 5000);
          }),
        ]);
        if (this.cleanupFailed) throw new Error('远程查询清理未能完成，请检查本机 SSH 进程。');
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.shutdown;
  }
  private async terminate(child: ChildProcessWithoutNullStreams) {
    try {
      await this.deps.terminate(child);
    } catch {
      this.cleanupFailed = true;
      throw new Error('远程查询连接清理失败。');
    }
  }
  private async runQueryOnce(projectId: string, name: string, signal?: AbortSignal): Promise<ProjectQueryResult> {
    const project = this.project(projectId),
      config = this.get(projectId);
    const query = config.sshQueries.find((item) => item.name === name);
    if (!query) throw new Error('这个远程查询没有获得当前项目的用户授权。');
    if (query.background || query.params) throw new Error('这是远程作业，请用 run_remote_job。');
    if (this.active.has(projectId)) throw new Error('这个项目已有远程查询正在运行。');
    const controller = new AbortController();
    this.active.set(projectId, controller);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const args = ['-T', '-n', ...hardenedSshOptions(), '--', query.host, query.argv.map(quote).join(' ')];
    let child: ChildProcessWithoutNullStreams | undefined,
      status: ProjectQueryResult['status'] | undefined,
      stdout = '',
      stderr = '',
      size = 0,
      launchPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined, settleStop!: () => void;
    const stopped = new Promise<void>((done) => {
      settleStop = done;
    });
    const abort = () => {
      status ??= 'cancelled';
      settleStop();
    };
    combined.addEventListener('abort', abort, { once: true });
    try {
      if (combined.aborted) return { name, status: 'cancelled', stdout, stderr };
      timer = setTimeout(
        () => {
          status = 'timed-out';
          controller.abort();
        },
        (query.timeoutSeconds ?? 30) * 1000,
      );
      launchPending = true;
      const pending = this.deps.launch(args, { cwd: project.path, signal: combined });
      const launchCleanup = pending.then(
        async (value) => {
          if (status) {
            try {
              await this.terminate(value);
            } finally {
              launchPending = false;
              if (this.active.get(projectId) === controller) this.active.delete(projectId);
            }
          } else launchPending = false;
        },
        () => {
          launchPending = false;
          if (status && this.active.get(projectId) === controller) this.active.delete(projectId);
        },
      );
      this.launches.add(launchCleanup);
      void launchCleanup.finally(() => this.launches.delete(launchCleanup)).catch(() => {});
      child = await Promise.race([pending, stopped.then(() => undefined)]);
      if (!child) return { name, status: status ?? 'cancelled', stdout, stderr, remoteMayContinue: true };
      this.project(projectId);
      if (this.get(projectId).revision !== config.revision) controller.abort();
      const consume = (target: 'stdout' | 'stderr', bytes: Buffer | string) => {
        const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        const retained = chunk.subarray(0, Math.max(0, outputLimit - size)).toString('utf8');
        if (target === 'stdout') stdout += retained;
        else stderr += retained;
        size += chunk.length;
        if (size > outputLimit) {
          status ??= 'output-limit';
          controller.abort();
        }
      };
      child.stdout.on('data', (bytes) => consume('stdout', bytes));
      child.stderr.on('data', (bytes) => consume('stderr', bytes));
      const closed = new Promise<number | null>((done) => {
        child!.once('close', done);
        child!.once('error', () => {
          status ??= 'failed';
          done(null);
        });
        if (child!.exitCode !== null) done(child!.exitCode);
      });
      child.stdin.end();
      const exitCode = await Promise.race([closed, stopped.then(() => null)]);
      return {
        name,
        status: status ?? (exitCode === 0 ? 'completed' : 'failed'),
        ...(exitCode === null ? {} : { exitCode }),
        stdout: sanitized(stdout),
        stderr: sanitized(stderr),
        ...(status && ['cancelled', 'timed-out', 'output-limit'].includes(status) ? { remoteMayContinue: true } : {}),
      };
    } catch {
      return {
        name,
        status: status ?? (combined.aborted ? 'cancelled' : 'failed'),
        stdout: sanitized(stdout),
        stderr: sanitized(stderr || 'SSH 查询未能完成，请检查本机已有的 SSH 配置和主机信任记录。'),
        ...(combined.aborted ? { remoteMayContinue: true } : {}),
      };
    } finally {
      clearTimeout(timer);
      combined.removeEventListener('abort', abort);
      try {
        if (child) await this.terminate(child);
      } finally {
        if (!launchPending && this.active.get(projectId) === controller) this.active.delete(projectId);
      }
    }
  }
}
