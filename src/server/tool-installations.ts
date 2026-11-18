import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { runtimeRoot } from '../../scripts/runtime-paths.mjs';
import { releaseVoice, voiceInUse, voiceModelDirectory } from './voice.ts';
import { memoryModelDirectory, stopMemoryIndexing } from './memory-vectors.ts';
import { imageModelDirectory, imageSearchInUse, pauseImageBackground } from './image-search.ts';
import { markitdown, markitdownInUse } from './local-tools.ts';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { installableToolIds, type InstallableToolId, type ToolInstallation } from '../shared/tool-installations.ts';
import { runToolInstaller, type InstallationProgress } from './tool-installer.ts';

type Runner = (
  tool: InstallableToolId,
  progress: (value: InstallationProgress) => void,
  signal: AbortSignal,
) => Promise<string>;
const savedJob = z.object({
  id: z.string().min(1).max(100),
  tool: z.enum(installableToolIds),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  phase: z.enum(['preparing', 'downloading', 'verifying', 'installing', 'completed', 'failed', 'interrupted']),
  message: z.string().max(1000),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  receivedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().positive().optional(),
});

export class ComponentConflict extends Error {}

const detected = {
  voice: voiceModelDirectory,
  'image-search': imageModelDirectory,
  'memory-search': memoryModelDirectory,
  markitdown,
};

export class ToolInstallations {
  private readonly file: string;
  private readonly jobs: ToolInstallation[] = [];
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private closed = false;
  private readonly removing = new Set<InstallableToolId>();
  constructor(
    private readonly appRoot: string,
    dataDir: string,
    private readonly runner: Runner = (tool, progress, signal) => runToolInstaller(appRoot, tool, progress, signal),
  ) {
    this.file = join(dataDir, 'tool-installations.json');
    if (existsSync(this.file)) {
      try {
        const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!Array.isArray(saved)) throw new Error('Invalid component installation history.');
        for (const value of saved.slice(-40)) {
          const parsed = savedJob.safeParse(value);
          if (!parsed.success) continue;
          const job: ToolInstallation = parsed.data;
          if (job.status === 'running')
            Object.assign(job, {
              status: 'interrupted',
              phase: 'interrupted',
              message: '上次安装已中断，可以重试。',
              updatedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            });
          this.jobs.push(job);
        }
        this.saveStatus();
      } catch {
        // Installation history is recoverable metadata, never a reason to prevent
        // all conversations from opening. Preserve unreadable data for inspection.
        this.jobs.length = 0;
        try {
          renameSync(this.file, `${this.file}.corrupt-${randomUUID()}`);
        } catch {
          /* Original stays in place. */
        }
        console.warn('[components] installation history could not be restored; previous file preserved');
      }
    }
  }
  list(): ToolInstallation[] {
    return this.jobs.map((job) => ({ ...job }));
  }
  start(tool: InstallableToolId): ToolInstallation {
    if (this.closed) throw new Error('应用正在退出，暂时不能安装组件。');
    if (!installableToolIds.includes(tool)) throw new Error('未知组件。');
    if (this.removing.has(tool)) throw new ComponentConflict('组件正在卸载，请稍后再安装。');
    const running = this.jobs.find((job) => job.tool === tool && job.status === 'running');
    if (running) return { ...running };
    const now = new Date().toISOString();
    const job: ToolInstallation = {
      id: randomUUID(),
      tool,
      status: 'running',
      phase: 'preparing',
      message: '正在准备安装组件。',
      startedAt: now,
      updatedAt: now,
    };
    const previous = [...this.jobs];
    this.jobs.push(job);
    while (this.jobs.length > 40) {
      const old = this.jobs.findIndex((item) => item.status !== 'running');
      if (old < 0) break;
      this.jobs.splice(old, 1);
    }
    try {
      this.persist();
    } catch (error) {
      this.jobs.splice(0, this.jobs.length, ...previous);
      throw error;
    }
    const abort = new AbortController();
    const promise = Promise.resolve()
      .then(() =>
        this.runner(
          tool,
          (value) => {
            if (job.status !== 'running') return;
            // Byte counts are per download file, never presented as a made-up total percentage.
            delete job.receivedBytes;
            delete job.totalBytes;
            Object.assign(job, value, { updatedAt: new Date().toISOString() });
            this.saveStatus();
          },
          abort.signal,
        ),
      )
      .then((message) => {
        if (job.status !== 'running') return;
        Object.assign(job, {
          status: 'completed',
          phase: 'completed',
          message,
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        this.saveStatus();
      })
      .catch((error: unknown) => {
        if (job.status !== 'running') return;
        const interrupted = abort.signal.aborted;
        Object.assign(job, {
          status: interrupted ? 'interrupted' : 'failed',
          phase: interrupted ? 'interrupted' : 'failed',
          message: interrupted
            ? '安装已中断，可以重试。'
            : error instanceof Error
              ? error.message.slice(0, 240)
              : '组件安装失败，请重试。',
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        this.saveStatus();
      })
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, { abort, promise });
    return { ...job };
  }
  async remove(tool: InstallableToolId): Promise<{ removed: true }> {
    if (!installableToolIds.includes(tool)) throw new Error('未知组件。');
    if (this.closed) throw new ComponentConflict('应用正在退出，暂时不能卸载组件。');
    if (this.removing.has(tool)) throw new ComponentConflict('组件正在卸载，请稍后再试。');
    if (this.jobs.some((job) => job.tool === tool && job.status === 'running'))
      throw new ComponentConflict('组件正在安装，请安装结束后再卸载。');
    if (tool === 'markitdown' && markitdownInUse())
      throw new ComponentConflict('正在读取办公文档，请转换结束后再卸载组件。');
    if ((tool === 'voice' && voiceInUse()) || (tool === 'image-search' && imageSearchInUse()))
      throw new ComponentConflict('组件正在使用，请任务结束后再卸载。');
    const root = runtimeRoot(this.appRoot);
    const dir = join(root, tool);
    let turnedOff = false;
    this.removing.add(tool);
    try {
      // A development checkout can reach shared components through any directory on this path.
      if (!process.env.PUGPORT_RUNTIME_DIR && root === join(this.appRoot, '.runtime')) {
        for (let path = resolve(dir); ; path = dirname(path)) {
          if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
            throw new ComponentConflict('这个开发副本的组件文件夹与其他副本共用，这里不会卸载。');
          if (path === resolve(this.appRoot)) break;
        }
      }
      const entry = lstatSync(dir, { throwIfNoEntry: false });
      const found = detected[tool](this.appRoot);
      if (found && found !== dir && !found.startsWith(dir + sep))
        throw new ComponentConflict(`此组件在 ${dirname(found)}，由旧版便携副本安装，PugPort 不会删除它。`);
      // Invalidate readiness before yielding, so no new conversion can start during removal.
      // Unlink directory links themselves; readiness-file removal must not traverse them.
      if (entry?.isSymbolicLink()) unlinkSync(dir);
      else if (entry) {
        const readiness = {
          voice: 'sense-voice',
          'image-search': 'vocab.txt',
          'memory-search': 'tokenizer.json',
          markitdown: '.pugport-ready',
        }[tool];
        const path = join(dir, readiness);
        if (tool === 'voice' && !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
          rmSync(join(path, 'tokens.txt'), { force: true });
        else rmSync(path, { force: true });
      }
      turnedOff = true;
      if (tool === 'voice') releaseVoice();
      if (tool === 'memory-search') stopMemoryIndexing();
      if (tool === 'image-search') pauseImageBackground();
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      const remaining = detected[tool](this.appRoot);
      if (remaining)
        throw new ComponentConflict(`此组件在 ${dirname(remaining)}，由旧版便携副本安装，PugPort 不会删除它。`);
      return { removed: true };
    } catch (error) {
      if (error instanceof ComponentConflict) throw error;
      if (turnedOff)
        throw new ComponentConflict(
          `组件已停用，但有些文件没能删除：${dir}（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）。退出 PugPort 后可以手动删除这个文件夹。`,
        );
      throw new ComponentConflict(
        `无法删除组件目录：${dir}。请稍后重试。（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）`,
      );
    } finally {
      this.removing.delete(tool);
    }
  }
  async wait(id: string): Promise<ToolInstallation | undefined> {
    await this.active.get(id)?.promise;
    return this.list().find((job) => job.id === id);
  }
  close(): void {
    this.closed = true;
    for (const job of this.jobs)
      if (job.status === 'running') {
        Object.assign(job, {
          status: 'interrupted',
          phase: 'interrupted',
          message: '安装已中断，可以重试。',
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        this.active.get(job.id)?.abort.abort();
      }
    this.saveStatus();
  }
  private saveStatus() {
    try {
      this.persist();
    } catch {
      console.warn('[components] could not save installation status');
    }
  }
  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.jobs), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

/** Mount only behind the main server's localhost/origin/session-token checks. */
export function toolInstallationRoutes(app: Express, installations: ToolInstallations) {
  app.get('/api/tool-installations', (_req, res) => res.json({ installations: installations.list() }));
  app.delete('/api/tool-installations/:tool', async (req, res, next) => {
    const parsed = z.enum(installableToolIds).safeParse(req.params.tool);
    if (!parsed.success) return res.status(400).json({ error: '未知组件。' });
    try {
      res.json(await installations.remove(parsed.data));
    } catch (error) {
      if (error instanceof ComponentConflict) res.status(409).json({ error: error.message });
      else next(error);
    }
  });
  app.post('/api/tool-installations', (req, res) => {
    const { tool } = z
      .object({ tool: z.enum(installableToolIds) })
      .strict()
      .parse(req.body);
    res.status(202).json({ installation: installations.start(tool) });
  });
}
