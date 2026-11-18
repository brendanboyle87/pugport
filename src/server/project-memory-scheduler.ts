import { track } from './memory-telemetry.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Controller } from './controller.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import type { AutoNoteItem, Project, RunInput, RunRecord, MemoryAutoView } from '../shared/types.ts';
import {
  distillationPrompt,
  distillationInput,
  distillationStats,
  distillationStatsSteps,
  parseNoteChanges,
  noteItems,
  mergeNote,
  renderNote,
  pickDistiller,
  shouldDistill,
  type DistillationHistory,
  type DistillationScanCache,
  type DistillationStats,
} from './memory-distillation.ts';
import { supportsToolless } from './routing.ts';

type Attempt = DistillationHistory & { id: string; status: 'running' | 'completed' | 'failed'; runId?: string };
/** Per project: task id, updatedAt, cut-off, tool events, events, duration, usable characters, finished (1/0). */
type SavedScans = {
  version: 1;
  projects: Record<string, Array<[string, string, number, number, number, number, number, 0 | 1]>>;
};
const label = '整理项目记忆';

/** One attempt at a time. Durable reservations also count failed/interrupted attempts against the caps. */
export class MemoryDistillationScheduler {
  private timer?: NodeJS.Timeout;
  private active?: AbortController;
  private checking = false;
  private closed = false;
  private pending?: Promise<void>;
  private views = new Map<string, { at: number; stats: ReturnType<typeof distillationStats>; since: number }>();
  private scans?: Map<string, DistillationScanCache>;
  private saving?: NodeJS.Timeout;
  constructor(
    private host: {
      controller: Controller;
      store: WorkspaceStore;
      idle(): boolean;
      language(project: Project): string;
      now?: () => number;
      timeoutMs?: number;
    },
  ) {}

  start() {
    this.timer = setInterval(() => void this.check().catch(() => undefined), 10 * 60 * 1000);
    this.timer.unref();
  }
  private history(): Attempt[] {
    return this.host.store.get<{ attempts: Attempt[] }>('memory-distillation-history', 'global')?.attempts ?? [];
  }
  private save(attempt: Attempt) {
    const attempts = this.history().filter((item) => item.id !== attempt.id);
    attempts.push(attempt);
    this.host.store.save('memory-distillation-history', 'global', 'global', { attempts });
  }
  /** History later than the project's last completed note is what the next one is made from. */
  private since(project: Project, history: readonly Attempt[]) {
    return Math.max(
      0,
      ...history
        .filter((item) => item.projectId === project.id && item.status === 'completed')
        .map((item) => Date.parse(item.at)),
    );
  }
  /**
   * Each task's numbers, kept while the task is unchanged and across restarts: only a task that changed has its
   * runs read again. Numbers only (counts and times), in a file beside the database.
   */
  private scanned(projectId: string): DistillationScanCache {
    if (!this.scans) {
      this.scans = new Map();
      const file = this.scanFile();
      try {
        const saved = file ? (JSON.parse(readFileSync(file, 'utf8')) as SavedScans) : undefined;
        if (saved?.version === 1)
          for (const [id, rows] of Object.entries(saved.projects))
            this.scans.set(
              id,
              new Map(
                rows.map(([workflow, updatedAt, since, toolEvents, eventCount, durationMs, usableCharacters, done]) => [
                  workflow,
                  {
                    updatedAt,
                    since,
                    entry: {
                      id: workflow,
                      updatedAt,
                      finishedAt: done ? updatedAt : undefined,
                      toolEvents,
                      eventCount,
                      durationMs,
                      usableCharacters,
                    },
                  },
                ]),
              ),
            );
      } catch {
        // No file yet, or an unreadable one: the next scan rebuilds it.
      }
    }
    let scan = this.scans.get(projectId);
    if (!scan) this.scans.set(projectId, (scan = new Map()));
    return scan;
  }
  /** After a whole scan, tasks that are gone leave the record too. */
  private keep(projectId: string, stats: DistillationStats) {
    const scan = this.scanned(projectId);
    const present = new Set(stats.workflows.map((item) => item.id));
    for (const id of scan.keys()) if (!present.has(id)) scan.delete(id);
    if (!this.scanFile() || this.saving) return;
    this.saving = setTimeout(() => this.writeScans(), 5000);
    this.saving.unref();
  }
  private scanFile() {
    const dataDir = (this.host.controller as { dataDir?: string }).dataDir;
    return dataDir ? join(dataDir, 'memory-distillation-scan.json') : undefined;
  }
  private writeScans() {
    clearTimeout(this.saving);
    this.saving = undefined;
    const file = this.scanFile();
    if (!file || !this.scans) return;
    const saved: SavedScans = { version: 1, projects: {} };
    for (const [id, scan] of this.scans)
      if (scan.size)
        saved.projects[id] = [...scan].map(([workflow, { updatedAt, since, entry }]) => [
          workflow,
          updatedAt,
          since,
          entry.toolEvents,
          entry.eventCount,
          entry.durationMs,
          entry.usableCharacters,
          entry.finishedAt ? 1 : 0,
        ]);
    try {
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(saved));
      renameSync(temporary, file);
    } catch {
      // A missed save only means these tasks are read once more after the next start.
    }
  }
  /**
   * Reads what a project's scan still lacks a little at a time, giving the event loop a turn every 25 ms, so the
   * first scan of a large project no longer holds the backend. Work arriving in between ends it.
   */
  private async warm(project: Project) {
    const { controller, store } = this.host;
    if (controller.settings.memoryDistillation?.enabled !== true || project.scope === 'chat') return;
    const since = this.since(project, this.history());
    const steps = distillationStatsSteps(
      project,
      { store, run: (id) => controller.store.storedRunForDistillation(id, since) },
      since,
      this.scanned(project.id),
    );
    try {
      let sliceEnds = performance.now() + 25;
      let step = steps.next();
      while (!step.done) {
        if (performance.now() >= sliceEnds) {
          await new Promise((resolve) => setImmediate(resolve));
          if (this.closed || !this.host.idle()) return;
          sliceEnds = performance.now() + 25;
        }
        step = steps.next();
      }
      return { since, stats: step.value };
    } finally {
      steps.return({ workflows: [] });
    }
  }
  private prepare(
    project: Project,
    ownAttempt?: string,
    cached = false,
    warmed?: { since: number; stats: DistillationStats },
  ) {
    const { controller, store } = this.host;
    const now = (this.host.now ?? Date.now)();
    if (controller.settings.memoryDistillation?.enabled !== true) return { reason: '请先开启自动整理项目记忆。' };
    if (this.closed || (this.active && !ownAttempt) || !this.host.idle())
      return { reason: '有任务正在运行或等待，请空闲后再试。' };
    if (project.scope === 'chat') return { reason: '普通聊天不整理项目记忆。' };
    const history = this.history().filter((item) => item.id !== ownAttempt);
    const since = this.since(project, history);
    const previous = cached ? this.views.get(project.id) : undefined;
    const stats =
      warmed?.since === since
        ? warmed.stats
        : previous && previous.since === since && now - previous.at < 60000
          ? previous.stats
          : distillationStats(
              project,
              { store, run: (id) => controller.store.storedRunForDistillation(id, since) },
              since,
              this.scanned(project.id),
            );
    if (stats !== previous?.stats) this.keep(project.id, stats);
    if (cached && stats !== previous?.stats) {
      if (this.views.size >= 100) this.views.delete(this.views.keys().next().value!);
      this.views.set(project.id, { at: now, stats, since });
    }
    if (!shouldDistill(project, stats, now, history))
      return { reason: '新进展不足，或已达到每项目 24 小时一次、每天共三次的限制。' };
    const candidate = pickDistiller(
      controller.snapshots,
      controller.targets,
      controller.settings,
      controller.quotaHistory.burnRates(),
      now,
    );
    if (!candidate) return { reason: '暂无读数新鲜且预计浪费至少 20 点额度的已勾选执行器。' };
    if (!supportsToolless(controller.snapshots.find((item) => item.id === candidate.runtimeId)))
      return { reason: '选中的执行器暂不支持无工具整理。' };
    const runInput: RunInput = {
      prompt: distillationPrompt('', this.host.language(project), []),
      userInput: label,
      projectPath: project.path,
      kind: 'routine',
      runtimeId: candidate.runtimeId,
      automaticExecutorSelection: true,
      automaticExecutors: [candidate.runtimeId],
      permissionMode: 'read-only',
      untrustedContent: true,
      agentCalls: false,
      allowExecutorFallback: false,
      memoryDistillation: true,
    };
    try {
      controller.preview(runInput);
    } catch {
      return { reason: '选中的执行器当前不满足运行条件。' };
    }
    return { input: runInput, since };
  }
  view(project: Project): MemoryAutoView {
    const note = this.host.store.memoryAuto(project.id);
    const prepared = this.prepare(project, undefined, true);
    return {
      note,
      eligible: !!prepared.input,
      reason: prepared.reason,
      sourceLabel: note
        ? (this.host.controller.targets.find((item) => item.id === note.sourceRuntimeId)?.label ?? note.sourceRuntimeId)
        : undefined,
    };
  }
  clear(project: Project) {
    if (this.active) throw new Error('正在整理，请结束后再清除。');
    this.host.store.deleteMemoryAuto(project.id);
    // Clearing a note never clears the spending history.
    this.host.controller.broadcast();
    return this.view(project);
  }
  async check(project?: Project): Promise<void> {
    const end = track('memory-distillation-check');
    try {
      await this.checkNow(project);
    } finally {
      end();
    }
  }
  private async checkNow(project?: Project): Promise<void> {
    if (
      this.active ||
      this.checking ||
      this.closed ||
      this.host.controller.settings.memoryDistillation?.enabled !== true ||
      !this.host.idle()
    ) {
      if (project) throw new Error(this.checking ? '正在检查项目记忆，请稍后再试。' : this.view(project).reason);
      return;
    }
    this.checking = true;
    try {
      await this.checkProjects(project);
    } finally {
      this.checking = false;
    }
  }
  private async checkProjects(project?: Project): Promise<void> {
    for (const item of project ? [project] : this.host.store.projects()) {
      // Give the server a turn between projects, and inside a project whose tasks still have to be read.
      let warmed: Awaited<ReturnType<MemoryDistillationScheduler['warm']>>;
      if (!project) {
        await new Promise((resolve) => setImmediate(resolve));
        warmed = await this.warm(item);
      }
      const prepared = this.prepare(item, undefined, false, warmed);
      if (!prepared.input) {
        if (project) throw new Error(prepared.reason);
        continue;
      }
      const previous = noteItems(this.host.store.memoryAuto(item.id));
      prepared.input.prompt = distillationPrompt(
        distillationInput(
          item,
          {
            store: this.host.store,
            run: (id) => this.host.controller.store.storedRunForDistillation(id, prepared.since),
          },
          prepared.since,
        ),
        this.host.language(item),
        previous,
      );
      this.pending = this.run(item, prepared.input, previous);
      await this.pending;
      return;
    }
  }
  private async run(project: Project, input: RunInput, previous: AutoNoteItem[]) {
    const end = track('memory-distillation-run');
    const { controller, store } = this.host;
    const abort = new AbortController();
    this.active = abort;
    const attempt: Attempt = {
      id: randomUUID(),
      projectId: project.id,
      at: new Date((this.host.now ?? Date.now)()).toISOString(),
      status: 'running',
    };
    this.save(attempt);
    let run: RunRecord | undefined;
    let poll: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (run) controller.cancel(run.id);
    };
    abort.signal.addEventListener('abort', cancel);
    const timeout = setTimeout(() => abort.abort(), this.host.timeoutMs ?? 10 * 60 * 1000);
    try {
      const stopped = new Promise<never>((_, reject) =>
        abort.signal.addEventListener('abort', () => reject(new Error('整理已取消或超时。')), { once: true }),
      );
      await Promise.race([
        stopped,
        (async () => {
          await controller.start(
            input,
            undefined,
            abort.signal,
            () => {
              const current = this.prepare(project, attempt.id);
              if (!current.input || current.input.runtimeId !== input.runtimeId) throw new Error('整理条件已变化。');
            },
            (created) => {
              run = created;
              attempt.runId = created.id;
              this.save(attempt);
              if (abort.signal.aborted) cancel();
            },
          );
          abort.signal.throwIfAborted();
          await new Promise<void>((resolve) => {
            const inspect = () => {
              if (abort.signal.aborted || run?.endedAt) resolve();
            };
            poll = setInterval(inspect, 50);
            inspect();
          });
          abort.signal.throwIfAborted();
          const owner = store.get<Project>('project', project.id);
          if (!owner || owner.removedAt || store.get('project-purge', project.id)) throw new Error('项目已移除。');
          const changes = run?.status === 'completed' ? parseNoteChanges(run.output) : undefined;
          if (!changes) {
            if (run?.status === 'completed') {
              run.status = 'failed';
              run.error = '自动整理结果格式无效，已丢弃。';
              controller.store.saveRun(run);
              const target = controller.targets.find((item) => item.id === run!.route.runtimeId);
              if (target) controller.usage.begin(run, target);
            }
            throw new Error('整理未产生有效笔记。');
          }
          if (changes.length) {
            const items = mergeNote(previous, changes, attempt.at);
            if (!items.length) store.deleteMemoryAuto(project.id);
            else
              store.setMemoryAuto(project.id, {
                content: renderNote(items),
                items,
                sourceRuntimeId: run!.route.runtimeId,
                runId: run!.id,
              });
          }
          attempt.status = 'completed';
        })(),
      ]);
    } catch {
      attempt.status = 'failed';
    } finally {
      clearInterval(poll);
      clearTimeout(timeout);
      abort.signal.removeEventListener('abort', cancel);
      this.save(attempt);
      this.active = undefined;
      this.views.delete(project.id);
      end();
      controller.broadcast();
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.saving) this.writeScans();
    this.active?.abort();
    return this.pending;
  }
}
