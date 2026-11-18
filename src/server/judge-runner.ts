import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Project, RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';
import { safeToolEventValue } from '../shared/tool-event-data.ts';
import { codexWindowsSandbox } from './adapters/codex.ts';
import { spawnTarget, terminateProcess } from './adapters/process.ts';
import { createDetachedCheckout, hostGit, removeDetachedCheckout } from './managed-worktrees.ts';
import { nativeAccountEnvironment } from './native-accounts.ts';
import { mxcRuntime } from './sandbox/mxc-runtime.ts';
import { redactToolDiagnostic } from './tool-diagnostics.ts';
import { parseJudgeConfig, parseVerdict, provenanceLine, renderJudgePrompt } from './judge-config.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import { serverRole } from './node/role.ts';

type JudgeDeps = {
  spawn: typeof spawnTarget;
  terminate: typeof terminateProcess;
  createCheckout: typeof createDetachedCheckout;
  removeCheckout: typeof removeDetachedCheckout;
  platform: NodeJS.Platform;
  role: 'desktop' | 'node';
  sandboxStatus: typeof mxcRuntime.probe;
  clock: () => number;
};
type JudgeRecord = {
  id: string;
  projectId: string;
  sha: string;
  executor: 'codex' | 'claude';
  status: 'running' | 'completed' | 'invalid' | 'failed' | 'timed-out' | 'cancelled';
  file: string;
  startedAt: string;
  endedAt?: string;
  checkoutRetainedAt?: string;
  verdict?: string;
  firstLine?: string;
  signature?: string;
  text?: string;
  provenance?: string;
  note?: string;
  error?: string;
  events: { at: string; phase: string; detail?: unknown }[];
};
type Host = {
  dataDir: string;
  store: Pick<WorkspaceStore, 'get' | 'list' | 'save'>;
  targets: () => RuntimeTarget[];
  snapshots: () => RuntimeSnapshot[];
};
type Audit = (phase: string, fields: Record<string, unknown>) => void;
const defaults: JudgeDeps = {
  spawn: spawnTarget,
  terminate: terminateProcess,
  createCheckout: createDetachedCheckout,
  removeCheckout: removeDetachedCheckout,
  platform: process.platform,
  role: serverRole(),
  sandboxStatus: mxcRuntime.probe,
  clock: Date.now,
};
const kind = 'judge-run';
const limit = 4 * 1024 * 1024;

export class JudgeRunner {
  private readonly deps: JudgeDeps;
  private active?: { id: string; done: Promise<void>; abort: AbortController };
  private sweeping?: Promise<void>;
  constructor(
    private readonly host: Host,
    deps: Partial<JudgeDeps> = {},
  ) {
    this.deps = { ...defaults, ...deps };
  }
  private save(record: JudgeRecord) {
    this.host.store.save(kind, record.id, record.projectId, record);
  }
  private resultOf(record: JudgeRecord) {
    return {
      judge_id: record.id,
      status: record.status,
      sha: record.sha,
      executor: record.executor,
      ...(record.verdict ? { verdict: record.verdict } : {}),
      ...(record.firstLine !== undefined ? { first_line: record.firstLine } : {}),
      ...(record.signature ? { signature: record.signature } : {}),
      ...(record.text !== undefined ? { text: record.text } : {}),
      file: record.file,
      ...(record.provenance ? { provenance: record.provenance } : {}),
      ...(record.note ? { note: record.note } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }
  private get(projectId: string, id: string) {
    const record = this.host.store.get<JudgeRecord>(kind, id);
    if (!record || record.projectId !== projectId) throw new Error('判官记录不属于这个项目。');
    return record;
  }
  private async sweep() {
    const root = join(this.host.dataDir, 'judge');
    const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of folders) {
      try {
        if (!entry.isDirectory() || !/^jg-\d{8}-[0-9a-f]{8}$/.test(entry.name) || entry.name === this.active?.id)
          continue;
        const dir = join(root, entry.name);
        const record = this.host.store.get<JudgeRecord>(kind, entry.name);
        const age = record?.startedAt ? Date.parse(record.startedAt) : (await stat(dir)).mtimeMs;
        if (!Number.isFinite(age) || this.deps.clock() - age <= 14 * 86400_000) continue;
        if (record?.checkoutRetainedAt) {
          const project = this.host.store.get<Project>('project', record.projectId);
          if (project) await this.deps.removeCheckout(project.path, join(dir, 'checkout'));
        }
        await rm(dir, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
  }
  async start(
    input: { projectId: string; sha: string; claim: string },
    options: { audit?: Audit; signal?: AbortSignal } = {},
  ) {
    if (typeof input.sha !== 'string' || !/^[0-9a-f]{40}$/.test(input.sha))
      throw new Error('sha 必须是 40 位小写十六进制提交号。');
    const project = this.host.store.get<Project>('project', input.projectId);
    if (!project || project.removedAt || project.scope === 'chat') throw new Error('只有项目任务可以运行判官。');
    if (this.deps.platform === 'darwin' || this.deps.role === 'node')
      throw new Error('带工具的判官只在 Windows 桌面运行；macOS 和设备节点请用无工具的 PR 判官。');
    let configText: string;
    try {
      configText = await readFile(join(project.path, '.pugport', 'judge.md'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Error('项目里没有 .pugport/judge.md；PugPort 只提供运行器，请把判官提示词放在那里（模板见文档）。');
    }
    const config = parseJudgeConfig(configText);
    const tracked =
      (await hostGit(project.path, ['ls-files', '--error-unmatch', '--', '.pugport/judge.md'], { allowFailure: true }))
        .code === 0;
    if (!input.claim || !input.claim.trim()) throw new Error('claim 不能为空。');
    if ((await hostGit(project.path, ['cat-file', '-e', `${input.sha}^{commit}`], { allowFailure: true })).code !== 0)
      throw new Error(`本地没有提交 ${input.sha}。`);
    const sweep = (this.sweeping ??= this.sweep());
    try {
      await sweep;
    } finally {
      if (this.sweeping === sweep) this.sweeping = undefined;
    }
    if (this.active)
      return {
        judge_id: this.active.id,
        status: 'busy' as const,
        error: `已有判官在运行（${this.active.id}），一机同时只跑一个；稍后再试或用 judge_result 等它。`,
      };
    const id = `jg-${new Date(this.deps.clock()).toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active = { id, abort, done };
    const onAbort = () => abort.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) abort.abort();
    const dir = join(this.host.dataDir, 'judge', id),
      checkout = join(dir, 'checkout'),
      file = join(dir, 'verdict.md');
    const record: JudgeRecord = {
      id,
      projectId: input.projectId,
      sha: input.sha,
      executor: config.executor,
      status: 'running',
      file,
      startedAt: new Date(this.deps.clock()).toISOString(),
      events: [],
      ...(tracked ? { note: '.pugport/judge.md 已被 git 跟踪，建议放进 .git/info/exclude。' } : {}),
    };
    const event = (phase: string, fields: Record<string, unknown> = {}) => {
      const detail = safeToolEventValue(fields);
      record.events.push({ at: new Date(this.deps.clock()).toISOString(), phase, detail });
      if (record.events.length > 50) record.events.shift();
      options.audit?.(phase, fields);
    };
    let checkoutCreated = false;
    try {
      const candidates = this.host
        .targets()
        .filter((t) => t.provider === config.executor && t.environment === 'native' && !t.gateway && t.enabled);
      const snapshots = this.host.snapshots();
      const target = config.account
        ? candidates.find((t) => t.label === config.account)
        : candidates.find((t) => snapshots.some((s) => s.id === t.id && s.status === 'ready'));
      if (!target) throw new Error(`没有可用的 ${config.executor} 账号来当判官。`);
      const snapshot = snapshots.find((s) => s.id === target.id);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(key)) delete env[key];
      const accountEnv = nativeAccountEnvironment(target, env);
      const userDoc =
        config.executor === 'codex'
          ? join(accountEnv.CODEX_HOME ?? join(homedir(), '.codex'), 'AGENTS.md')
          : join(accountEnv.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'CLAUDE.md');
      const userDocs = await access(userDoc).then(
        () => true,
        () => false,
      );
      const prompt = renderJudgePrompt(config.template, {
        sha: input.sha,
        repository: project.path,
        claim: input.claim,
        base: config.base,
        mode: 'dry',
      });
      await mkdir(join(dir, 'tmp'), { recursive: true });
      await mkdir(join(dir, 'memory'), { recursive: true });
      await writeFile(join(dir, 'prompt.md'), prompt);
      event('started', { judgeId: id, sha: input.sha, executor: config.executor });
      await this.deps.createCheckout(project.path, input.sha, checkout, abort.signal);
      checkoutCreated = true;
      event('checkout', { judgeId: id, sha: input.sha, executor: config.executor });
      const args =
        config.executor === 'codex'
          ? [
              'exec',
              '--ignore-user-config',
              '--ignore-rules',
              '--ephemeral',
              '-C',
              checkout,
              '-s',
              'workspace-write',
              '-c',
              `sandbox_workspace_write.network_access=${config.network}`,
              '--disable',
              'hooks',
              // Plugins start their own MCP servers: outside zero context, and a killed judge orphans them.
              '--disable',
              'plugins',
              ...(this.deps.platform === 'win32'
                ? ['-c', `windows.sandbox='${codexWindowsSandbox(await this.deps.sandboxStatus())}'`]
                : []),
              ...(config.model ? ['-m', config.model] : []),
              ...(config.effort ? ['-c', `model_reasoning_effort=${config.effort}`] : []),
              '--color',
              'never',
              '--json',
              '-o',
              join(dir, 'last.txt'),
              '-',
            ]
          : [
              '-p',
              '--output-format',
              'json',
              '--safe-mode',
              '--restricted',
              '--strict-mcp-config',
              '--no-session-persistence',
              '--disable-slash-commands',
              '--tools',
              'Read,Glob,Grep',
              '--permission-prompts',
              'none',
              '--settings',
              JSON.stringify({ autoMemoryDirectory: join(dir, 'memory') }),
              ...(config.model ? ['--model', config.model] : []),
              ...(config.effort ? ['--effort', config.effort] : []),
            ];
      const flags =
        config.executor === 'codex'
          ? [
              '--ignore-user-config',
              '--ignore-rules',
              '--ephemeral',
              '-s workspace-write',
              '--disable hooks',
              '--disable plugins',
            ]
          : [
              '--safe-mode',
              '--restricted',
              '--strict-mcp-config',
              '--no-session-persistence',
              '--disable-slash-commands',
              '--tools Read,Glob,Grep',
              '--permission-prompts none',
            ];
      record.provenance = provenanceLine({
        id,
        userDocs,
        configTracked: tracked,
        executor: config.executor,
        cliVersion: snapshot?.version,
        model: config.model,
        sha: input.sha,
        flags,
      });
      this.save(record);
      const child = await this.deps.spawn(target, args, {
        cwd: checkout,
        env,
        syncAccountConfig: false,
        runTemp: join(dir, 'tmp'),
        signal: abort.signal,
      });
      options.signal?.removeEventListener('abort', onAbort);
      event('spawned', { judgeId: id, sha: input.sha, executor: config.executor, argv: args });
      this.save(record);
      void this.collect(child, record, config.timeoutMinutes, prompt, dir, project.path, abort, event)
        .catch(() => {})
        .finally(() => {
          if (this.active?.id === id) this.active = undefined;
          finish();
        });
      return { judge_id: id, status: 'running' as const, sha: input.sha, executor: config.executor, file };
    } catch (error) {
      record.status = abort.signal.aborted ? 'cancelled' : 'failed';
      record.error = redactToolDiagnostic(String(error), 4096);
      record.endedAt = new Date(this.deps.clock()).toISOString();
      if ((error as { checkoutRetained?: boolean })?.checkoutRetained) {
        this.retain(record, checkout);
      }
      if (checkoutCreated) {
        try {
          await this.deps.removeCheckout(project.path, checkout);
        } catch {
          this.retain(record, checkout);
        }
      }
      if (checkoutCreated || record.checkoutRetainedAt) this.save(record);
      options.signal?.removeEventListener('abort', onAbort);
      if (this.active?.id === id) this.active = undefined;
      finish();
      throw error;
    }
  }
  private async collect(
    child: Awaited<ReturnType<typeof spawnTarget>>,
    record: JudgeRecord,
    minutes: number,
    prompt: string,
    dir: string,
    repo: string,
    abort: AbortController,
    event: (phase: string, fields?: Record<string, unknown>) => void,
  ) {
    let output = Buffer.alloc(0),
      stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      timedOut = false,
      terminating = false;
    const append = (a: Buffer, b: Buffer, cap: number) => Buffer.concat([a, b]).subarray(-cap);
    child.stdout.on('data', (data: Buffer) => {
      if (record.executor === 'claude') stdout = append(stdout, Buffer.from(data), limit);
      output = append(output, Buffer.from(data), limit);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr = append(stderr, Buffer.from(data), 4096);
      output = append(output, Buffer.from(data), limit);
    });
    const terminate = () => {
      if (!terminating) {
        terminating = true;
        void this.deps.terminate(child).catch(() => {});
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, minutes * 60_000);
    abort.signal.addEventListener('abort', terminate, { once: true });
    if (abort.signal.aborted) terminate();
    try {
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
        // A helper the CLI started can hold its pipes open after the CLI is gone: settle 2 s after exit at most.
        child.once('exit', (code) => setTimeout(() => resolve(code), 2000).unref());
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      const code = await exit;
      await writeFile(join(dir, 'cli.log'), output);
      if (timedOut) {
        record.status = 'timed-out';
        record.error = `判官超过 ${minutes} 分钟未结束，已终止。`;
      } else if (abort.signal.aborted) record.status = 'cancelled';
      else {
        let text = '';
        let unreadable = false;
        let claudeError: string | undefined;
        if (record.executor === 'codex') text = await readFile(join(dir, 'last.txt'), 'utf8').catch(() => '');
        else {
          try {
            const value = JSON.parse(stdout.toString('utf8'));
            if (value.is_error)
              claudeError = typeof value.result === 'string' && value.result ? value.result : '判官进程失败。';
            else if (typeof value.result !== 'string') unreadable = true;
            else text = value.result;
          } catch {
            unreadable = true;
          }
        }
        // A failed process explains itself on stderr; that beats "unreadable output".
        if (code !== 0 && !text)
          throw new Error(redactToolDiagnostic(stderr.toString('utf8'), 4096) || claudeError || '判官进程失败。');
        if (claudeError) throw new Error(claudeError);
        if (unreadable) throw new Error('判官输出无法解析。');
        const verdict = parseVerdict(text, record.sha);
        Object.assign(record, verdict, {
          status: verdict.verdict === 'invalid' ? 'invalid' : 'completed',
          text: Buffer.from(text)
            .subarray(0, 64 * 1024)
            .toString('utf8'),
        });
        if (verdict.verdict === 'invalid')
          record.error = `判官输出不符合结论格式（首行应为「判定词 @ 提交」），已按 invalid 记录：${verdict.firstLine.slice(0, 200)}`;
        await writeFile(record.file, `${text}\n\n${record.provenance}\n`);
        event('parsed', { judgeId: record.id, sha: record.sha, executor: record.executor });
      }
    } catch (error) {
      record.status = abort.signal.aborted ? 'cancelled' : timedOut ? 'timed-out' : 'failed';
      record.error = redactToolDiagnostic(String(error), 4096);
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', terminate);
      try {
        await this.deps.removeCheckout(repo, join(dir, 'checkout'));
      } catch {
        this.retain(record, join(dir, 'checkout'));
      }
      record.endedAt = new Date(this.deps.clock()).toISOString();
      event('cleaned', { judgeId: record.id, sha: record.sha, executor: record.executor });
      this.save(record);
    }
  }
  async result(projectId: string, id: string, waitSeconds = 0) {
    this.get(projectId, id);
    if (this.active?.id === id && waitSeconds > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.active.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.min(300, waitSeconds) * 1000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return this.resultOf(this.get(projectId, id));
  }
  async cancel(projectId: string, id: string) {
    this.get(projectId, id);
    if (this.active?.id === id) {
      this.active.abort.abort();
      await this.active.done;
    }
    return this.result(projectId, id);
  }
  async recover() {
    for (const record of this.host.store.list<JudgeRecord>(kind, undefined, Number.MAX_SAFE_INTEGER)) {
      if (record.status !== 'running') continue;
      record.status = 'failed';
      record.error = '应用重启，判官中断。';
      record.endedAt = new Date(this.deps.clock()).toISOString();
      const project = this.host.store.get<Project>('project', record.projectId),
        checkout = join(this.host.dataDir, 'judge', record.id, 'checkout');
      if (project)
        try {
          await this.deps.removeCheckout(project.path, checkout);
        } catch {
          this.retain(record, checkout);
        }
      this.save(record);
    }
  }
  async close() {
    const active = this.active;
    if (active) {
      active.abort.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          active.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 5_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
  private retain(record: JudgeRecord, checkout: string) {
    record.checkoutRetainedAt = new Date(this.deps.clock()).toISOString();
    record.note = [record.note, `detached checkout 清理失败，已保留：${checkout}`].filter(Boolean).join(' ');
  }
}
