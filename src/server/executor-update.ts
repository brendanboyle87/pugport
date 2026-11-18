import type { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { collectProcessOutput, redactPaths, spawnTarget, StartupTail, terminateProcess } from './adapters/process.ts';
import { fill, type Inbox } from './inbox.ts';
import { redactToolDiagnostic } from './tool-diagnostics.ts';
import { inboxText } from '../shared/inbox.ts';
import type { RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';

const updatable = new Set<RuntimeTarget['provider']>(['cursor', 'grok']);
type Host = {
  now(): number;
  dataDir: string;
  closing(): boolean;
  targets(): readonly RuntimeTarget[];
  snapshots(): readonly RuntimeSnapshot[];
  activeCount(): number;
  foregroundStarts(): number;
  hasExecutionCapacity(): boolean;
  providerBusy(ids: readonly string[]): boolean;
  newestRunStartedAt(): number | undefined;
  markUpdating(ids: readonly string[], on: boolean): void;
  refresh(ids: readonly string[]): Promise<void>;
  inbox: Pick<Inbox, 'raise' | 'resolve' | 'list'>;
  db: DatabaseSync;
};
type Result = { ok: boolean; exitCode: number | null; timedOut: boolean; tail: string };
type Entry = { attemptedAt: number; failures: number; holdUntil?: number; holdVersion?: string };
export type RollbackResult = { ok: boolean; reason: string };

export async function runUpdate(
  target: RuntimeTarget,
  signal: AbortSignal,
  dataDir: string,
  timeoutMs = 180_000,
): Promise<Result> {
  const tail = new StartupTail();
  let timedOut = false;
  let child: Awaited<ReturnType<typeof spawnTarget>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (child) void terminateProcess(child);
  };
  try {
    if (signal.aborted) return { ok: false, exitCode: null, timedOut, tail: '' };
    child = await spawnTarget({ ...target, args: undefined, accountId: undefined }, ['update']);
    child.stdin.end();
    child.stdout.on('data', (chunk: Buffer) => tail.write('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => tail.write('stderr', chunk));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    await collectProcessOutput(child, timeoutMs + 10_000, [0]).catch(() => undefined);
  } catch (error) {
    tail.write('stderr', String(error));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (child) await terminateProcess(child);
  }
  const exitCode = child?.exitCode ?? null;
  return {
    ok: exitCode === 0 && !timedOut && !signal.aborted,
    exitCode,
    timedOut,
    tail: redactToolDiagnostic(redactPaths(tail.text(), [dataDir, target.agentDir]), 2000),
  };
}

export class ExecutorUpdater {
  private running?: Promise<void>;
  private abort?: AbortController;
  constructor(
    private readonly host: Host,
    private readonly deps: {
      run?: (target: RuntimeTarget, signal: AbortSignal) => Promise<Result>;
      rename?: typeof renameSync;
    } = {},
  ) {
    host.db.exec('CREATE TABLE IF NOT EXISTS executor_update (provider TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  tick(): Promise<void> | undefined {
    const h = this.host;
    const now = h.now();
    const hour = new Date(now).getHours();
    if (
      h.closing() ||
      this.running ||
      hour < 1 ||
      hour >= 6 ||
      h.activeCount() !== 0 ||
      h.foregroundStarts() !== 0 ||
      !h.hasExecutionCapacity()
    )
      return;
    const newest = h.newestRunStartedAt();
    if (newest !== undefined && now - newest < 30 * 60_000) return;
    for (const provider of updatable) {
      const row = h.db.prepare('SELECT value FROM executor_update WHERE provider=?').get(provider) as
        { value: string } | undefined;
      let entry: Entry | undefined;
      try {
        entry = row ? JSON.parse(row.value) : undefined;
      } catch {
        continue;
      }
      const target = h.targets().find((t) => {
        const s = h.snapshots().find((snapshot) => snapshot.id === t.id);
        return (
          t.provider === provider &&
          t.enabled &&
          !t.executionDisabledByUser &&
          t.environment === 'native' &&
          !t.gateway &&
          s?.installed === true &&
          (s.status === 'ready' || s.status === 'error')
        );
      });
      if (!target) continue;
      const version = h.snapshots().find((s) => s.id === target.id)?.version;
      const heldVersion =
        entry?.holdUntil !== undefined && (entry.holdVersion === undefined || entry.holdVersion === version);
      if (heldVersion && now < entry!.holdUntil!) continue;
      if (entry && now - entry.attemptedAt < 24 * 60 * 60_000 && (!entry.holdUntil || heldVersion)) continue;
      const ids = h
        .targets()
        .filter((t) => t.provider === provider && t.environment === 'native')
        .map((t) => t.id);
      if (h.providerBusy(ids)) continue;
      const ready = new Set(
        h
          .snapshots()
          .filter((s) => ids.includes(s.id) && s.status === 'ready')
          .map((s) => s.id),
      );
      h.db
        .prepare(
          'INSERT INTO executor_update(provider,value) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value',
        )
        .run(provider, JSON.stringify({ attemptedAt: now, failures: (entry?.failures ?? 0) + 1 }));
      this.abort = new AbortController();
      h.markUpdating(ids, true);
      this.running = this.perform(target, ids, ready, entry, now, this.abort.signal).finally(() => {
        this.running = undefined;
        this.abort = undefined;
      });
      return this.running;
    }
  }
  async rollbackCli(target: RuntimeTarget): Promise<RollbackResult> {
    const h = this.host;
    const refuse = (reason: string): RollbackResult => ({ ok: false, reason });
    if (target.provider !== 'grok' || target.environment !== 'native' || target.gateway)
      return refuse('自动回滚仅支持本机 Grok 命令行。');
    const ids = h
      .targets()
      .filter((t) => t.provider === target.provider && t.environment === 'native')
      .map((t) => t.id);
    if (
      h.closing() ||
      this.running ||
      h.activeCount() ||
      h.foregroundStarts() ||
      !h.hasExecutionCapacity() ||
      h.providerBusy(ids)
    )
      return refuse('Grok 正忙，请在任务结束后重试。');
    const notice = h.inbox
      .list({ all: true })
      .find(
        (n) =>
          n.kind === 'executor-update' &&
          n.key === 'grok:broken' &&
          !n.resolvedAt &&
          n.action?.kind === 'rollback-cli' &&
          n.action.runtimeId === target.id,
      );
    if (!notice) return refuse('没有可回滚的 Grok 更新失败通知。');
    let entry: Entry;
    try {
      const row = h.db.prepare('SELECT value FROM executor_update WHERE provider=?').get('grok') as
        { value: string } | undefined;
      entry = row ? JSON.parse(row.value) : undefined;
      if (!entry || !Number.isFinite(entry.attemptedAt)) return refuse('找不到这次更新失败的记录。');
    } catch {
      return refuse('无法读取这次更新失败的记录。');
    }
    const command = target.command;
    const old = `${command}.old`;
    let timestamp = h.now();
    let broken = `${command}.broken-${timestamp}`;
    try {
      if (!isAbsolute(command)) return refuse('Grok 的程序路径必须是绝对路径。');
      const currentStat = lstatSync(command);
      const oldStat = lstatSync(old);
      if (!currentStat.isFile() || !oldStat.isFile() || currentStat.isSymbolicLink() || oldStat.isSymbolicLink())
        return refuse('Grok 程序和备份必须是普通文件，不能是符号链接。');
      if (
        dirname(realpathSync(command)) !== dirname(realpathSync(old)) ||
        dirname(resolve(command)) !== dirname(resolve(old))
      )
        return refuse('Grok 程序和备份必须在同一个文件夹中。');
      // File clocks are coarse (Linux ctime can trail Date.now() by a few ms); allow 2 s of slack.
      if (Math.max(oldStat.mtimeMs, oldStat.ctimeMs, oldStat.birthtimeMs) < entry.attemptedAt - 2_000)
        return refuse('Grok 备份早于这次更新失败，无法安全回滚。');
      for (;;) {
        try {
          lstatSync(broken);
          broken = `${command}.broken-${++timestamp}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          break;
        }
      }
    } catch {
      return refuse('找不到 Grok 程序或 .old 备份，或无法读取这些文件。');
    }
    const holdUntil = h.now() + 7 * 24 * 60 * 60_000;
    const saveHold = (version?: string) =>
      h.db
        .prepare('UPDATE executor_update SET value=? WHERE provider=?')
        .run(JSON.stringify({ ...entry, holdUntil, holdVersion: version }), 'grok');
    // The conservative hold must survive before any executable is moved.
    try {
      saveHold();
    } catch {
      return refuse('无法保存自动更新暂停记录，尚未回滚 Grok。请稍后重试。');
    }
    h.markUpdating(ids, true);
    const rename = this.deps.rename ?? renameSync;
    try {
      rename(command, broken);
      try {
        rename(old, command);
      } catch (error) {
        rename(broken, command);
        throw error;
      }
      h.inbox.resolve('executor-update', 'grok:broken');
    } catch {
      return refuse('无法回滚 Grok。文件已保留，可用于恢复。');
    } finally {
      h.markUpdating(ids, false);
    }
    const outcome: RollbackResult = {
      ok: true,
      reason: fill('已回滚 Grok，自动更新暂停 7 天。损坏的副本保存在：{0}', broken),
    };
    this.running = (async () => {
      try {
        await h.refresh(ids);
        try {
          saveHold(h.snapshots().find((s) => s.id === target.id)?.version);
        } catch {
          // Keep the already-persisted full hold when its restored version cannot be saved.
        }
      } catch {
        h.inbox.raise({
          kind: 'executor-update',
          key: 'grok:rollback-refresh',
          severity: 'warning',
          title: 'Grok 回滚后的检查失败',
          body: '已回滚 Grok，但检查失败。请打开连接页重新检查。',
        });
      }
    })().finally(() => {
      this.running = undefined;
    });
    await this.running;
    return outcome;
  }
  private async perform(
    target: RuntimeTarget,
    ids: string[],
    ready: Set<string>,
    previous: Entry | undefined,
    attemptedAt: number,
    signal: AbortSignal,
  ) {
    const h = this.host;
    let result: Result;
    try {
      result = await (this.deps.run ? this.deps.run(target, signal) : runUpdate(target, signal, h.dataDir));
    } catch (error) {
      result = {
        ok: false,
        exitCode: null,
        timedOut: false,
        tail: redactToolDiagnostic(redactPaths(String(error), [h.dataDir, target.agentDir]), 2000),
      };
    } finally {
      h.markUpdating(ids, false);
      await h.refresh(ids);
    }
    if (signal.aborted) return;
    const failures = result.ok ? 0 : (previous?.failures ?? 0) + 1;
    h.db
      .prepare(
        'INSERT INTO executor_update(provider,value) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value',
      )
      .run(target.provider, JSON.stringify({ attemptedAt, failures }));
    if (result.ok) h.inbox.resolve('executor-update', target.provider);
    const broken = h
      .snapshots()
      .find((s) => ready.has(s.id) && (s.status === 'missing' || s.note === 'runtime-protocol-incompatible'));
    if (broken) {
      for (const id of ready) {
        h.inbox.resolve('executor-missing', id);
        h.inbox.resolve('executor-incompatible', id);
      }
      h.inbox.resolve('executor-update', target.provider);
    }
    const existingBroken = h.inbox
      .list({ all: true })
      .some((n) => n.kind === 'executor-update' && n.key === `${target.provider}:broken` && !n.resolvedAt);
    if (broken || (failures >= 3 && !existingBroken)) {
      h.inbox.raise({
        kind: 'executor-update',
        key: broken ? `${target.provider}:broken` : target.provider,
        severity: 'warning',
        title: fill(inboxText.updateTitle, target.label),
        body: broken
          ? fill(target.provider === 'grok' ? inboxText.updateBrokeBody : inboxText.updateBrokeManualBody, target.label)
          : fill(inboxText.updateBody, target.label, String(failures)),
        details: broken ? [broken.errorDetail ?? broken.note, result.tail].filter(Boolean).join('\n') : result.tail,
        action: {
          kind: broken && target.provider === 'grok' ? 'rollback-cli' : 'update-cli',
          runtimeId: broken?.id ?? target.id,
        },
        source: { runtimeId: broken?.id ?? target.id, label: target.label },
      });
    }
  }
  close(): Promise<void> | undefined {
    this.abort?.abort();
    return this.running;
  }
}
