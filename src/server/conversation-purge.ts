import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Conversation, Project } from '../shared/types.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import type { Attachments } from './attachments.ts';
import { memoryConversationPaths, memoryStorageRoot } from './local-memory.ts';
import { inside, visit, type PurgeTarget } from './project-purge.ts';
import { deleteTraceContextRows } from './trace-context-records.ts';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const storedName = /^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/;
export type ConversationHistoryPurge = { count: number; olderCount: number; token: string; pendingCount: number };
export type ConversationPurgeResult = { deleted: number; skipped: number; kept: number; unsafe: number };
type Copy = { id: string; projectId: string; attachments: string[] };
export type ConversationCleanup = { id: string; projectId: string; copies: Copy[] };
type Host = {
  store: WorkspaceStore;
  dataDir: string;
  attachments: Pick<Attachments, 'cleanupFiles' | 'removeUnshared'>;
  assertAppIdle(): void;
  assertIdle(ids: string[]): void;
  quiesce(projectIds: string[]): Promise<void>;
  purgeMedia(ids: string[]): void;
  purgeRouting(ids: string[]): Promise<void>;
  finished(projectIds: string[]): Promise<void> | void;
};

/** Deletes app-owned copies only. Empty-project and recycle-bin cleanup stays in the incognito entry point. */
export class ConversationPurger {
  private busy = false;
  private purgeGeneration = 0;
  get generation() {
    return this.purgeGeneration;
  }
  constructor(private host: Host) {}
  get inProgress() {
    return this.busy;
  }

  private scope(now: number) {
    return this.host.store.deletedConversations(now, { allDates: true });
  }
  history(now = Date.now()): ConversationHistoryPurge {
    const all = this.scope(now);
    const shown = this.host.store.deletedConversations(now).length;
    const token = createHash('sha256')
      .update(JSON.stringify(all.map((item) => item.id).sort()))
      .digest('hex');
    return { count: shown, olderCount: all.length - shown, token, pendingCount: this.pending().length };
  }
  private sideChats() {
    const groups = new Map<string, Conversation[]>();
    for (const item of this.host.store.list<Conversation>('conversation', undefined, Number.MAX_SAFE_INTEGER)) {
      const parent = item.sideChat?.parentConversationId;
      if (parent) groups.set(parent, [...(groups.get(parent) ?? []), item]);
    }
    return groups;
  }
  private pending() {
    const { store } = this.host;
    return store.list<ConversationCleanup>('conversation-purge', undefined, Number.MAX_SAFE_INTEGER).filter((item) => {
      const project = store.get<Project>('project', item.projectId);
      return project && !project.removedAt && !store.get('project-purge', item.projectId);
    });
  }
  private ownsWorktree(conversation: Conversation) {
    return (
      !!conversation.lane?.workspaceId ||
      this.host.store.conversationWorkflows(conversation.id).some((workflow) => workflow.executionWorkspaceId)
    );
  }
  private idle(group: Conversation[]) {
    const ids = group.map((item) => item.id);
    try {
      this.host.assertIdle(ids);
    } catch {
      return false;
    }
    return !ids.some((id) => this.host.store.conversationBusy(id));
  }
  private snapshot(conversation: Conversation) {
    return JSON.stringify({
      conversation,
      workflows: this.host.store.conversationWorkflows(conversation.id),
      files: this.host.attachments.cleanupFiles(conversation.id),
    });
  }
  private async protect(targets: PurgeTarget[]) {
    // Every linked project is protected, including paths below the application's workspace root.
    for (const project of this.host.store.projects(true)) {
      const aliases = [resolve(project.path), await realpath(project.path).catch(() => resolve(project.path))];
      if (targets.some((target) => aliases.some((path) => inside(path, target.path) || inside(target.path, path))))
        throw Error('待清空数据与原项目文件夹重叠，未执行清空。');
    }
    for (const target of targets) await visit(target, false);
  }
  private allTargets(copy: Copy) {
    const root = join(this.host.dataDir, 'attachments');
    return [
      ...this.targets(copy.id, copy.projectId),
      ...copy.attachments.map((name) => ({ root, path: join(root, name) })),
    ];
  }
  private targets(id: string, projectId: string): PurgeTarget[] {
    const { dataDir } = this.host;
    return [
      { root: join(dataDir, 'member-results'), path: join(dataDir, 'member-results', id) },
      { root: join(dataDir, 'workspaces', 'missing-folder'), path: join(dataDir, 'workspaces', 'missing-folder', id) },
      { root: resolve(memoryStorageRoot(dataDir)), path: memoryConversationPaths(dataDir, projectId, id).directory },
    ];
  }
  private async plan(conversations: Conversation[]) {
    const copies = new Map<string, Copy>();
    const snapshots = new Map<string, string>();
    for (const conversation of conversations) {
      if (!uuid.test(conversation.id) || !uuid.test(conversation.projectId)) continue;
      const attachments = this.host.attachments.cleanupFiles(conversation.id);
      if (attachments.some((name) => !storedName.test(name))) continue;
      const copy: Copy = {
        id: conversation.id,
        projectId: conversation.projectId,
        attachments,
      };
      snapshots.set(copy.id, this.snapshot(conversation));
      try {
        await this.protect(this.allTargets(copy));
      } catch {
        continue;
      }
      copies.set(copy.id, copy);
    }
    return { copies, snapshots };
  }

  async empty(token: string, now = Date.now()): Promise<ConversationPurgeResult> {
    if (this.busy) throw Error('另一个清空操作正在进行，请稍后再试。');
    this.busy = true;
    try {
      if (!token || token !== this.history(now).token) throw Error('列表已有变化，请重新查看。');
      this.host.assertAppIdle();
      this.purgeGeneration++;
      const { store } = this.host;
      const result: ConversationPurgeResult = { deleted: 0, skipped: 0, kept: 0, unsafe: 0 };
      const groups = new Map<string, Conversation[]>();
      const version = () => {
        const changes = store.db.prepare('SELECT total_changes() AS count').get() as { count: number };
        const data = store.db.prepare('PRAGMA data_version').get() as { data_version: number };
        return [changes.count, data.data_version];
      };
      const before = version();
      const sides = this.sideChats();
      for (const conversation of this.scope(now)) {
        const group = [conversation, ...(sides.get(conversation.id) ?? [])];
        if (group.some((item) => this.ownsWorktree(item))) result.kept++;
        else if (!this.idle(group)) result.skipped++;
        else groups.set(conversation.id, group);
      }
      const plan = await this.plan([...groups.values()].flat());
      store.transaction(() => {
        this.host.assertAppIdle();
        if (token !== this.history(now).token) throw Error('列表已有变化，请重新查看。');
        const after = version();
        const currentSides = before.some((value, index) => value !== after[index]) ? this.sideChats() : sides;
        const selected: string[] = [];
        const receipts: ConversationCleanup[] = [];
        for (const [id, group] of groups) {
          const current = [store.get<Conversation>('conversation', id), ...(currentSides.get(id) ?? [])].filter(
            (item): item is Conversation => !!item,
          );
          if (
            current.length !== group.length ||
            current.some((item) => !group.some((previous) => previous.id === item.id))
          ) {
            result.unsafe++;
            continue;
          }
          if (current.some((item) => this.ownsWorktree(item))) {
            result.kept++;
            continue;
          }
          if (!this.idle(current)) {
            result.skipped++;
            continue;
          }
          if (
            current.some((item) => !plan.copies.has(item.id) || plan.snapshots.get(item.id) !== this.snapshot(item))
          ) {
            result.unsafe++;
            continue;
          }
          selected.push(...current.map((item) => item.id));
          receipts.push({
            id,
            projectId: current[0]!.projectId,
            copies: current.map((item) => plan.copies.get(item.id)!),
          });
          result.deleted++;
        }
        removeConversationRecords(store, selected);
        for (const receipt of receipts) store.save('conversation-purge', receipt.id, receipt.projectId, receipt);
      });
      const cleanups = this.pending();
      if (cleanups.length) {
        const projects = [...new Set(cleanups.map((item) => item.projectId))];
        try {
          await this.host.quiesce(projects);
        } catch (error) {
          console.warn('对话副本清理失败：', error);
          await this.host.finished(projects);
          throw error;
        }
      }
      const failures: unknown[] = [];
      const completed: string[] = [];
      const eligible: ConversationCleanup[] = [];
      for (const cleanup of cleanups) {
        let failed = false;
        const attempt = async (action: () => Promise<void> | void) => {
          try {
            await action();
          } catch (error) {
            failed = true;
            failures.push(error);
            console.warn('对话副本清理失败：', cleanup.id, error);
          }
        };
        const ids = cleanup.copies.map((copy) => copy.id);
        try {
          if (ids.some((id) => store.get('conversation', id))) throw Error('对话标识已变化。');
          if (
            cleanup.copies.some(
              (copy) =>
                !uuid.test(copy.id) ||
                !uuid.test(copy.projectId) ||
                copy.projectId !== cleanup.projectId ||
                copy.attachments.some((name) => !storedName.test(name)),
            )
          )
            throw Error('对话清理记录无效。');
          this.host.assertIdle(ids);
          await this.protect(cleanup.copies.flatMap((copy) => this.allTargets(copy)));
        } catch (error) {
          failures.push(error);
          console.warn('对话副本清理失败：', cleanup.id, error);
          continue;
        }
        eligible.push(cleanup);
        for (const copy of cleanup.copies) {
          for (const target of this.targets(copy.id, copy.projectId))
            await attempt(async () => {
              await visit(target, true);
            });
          await attempt(() => this.host.attachments.removeUnshared(copy.id, copy.attachments));
        }
        if (!failed) completed.push(cleanup.id);
      }
      const batchIds = eligible.flatMap((cleanup) => cleanup.copies.map((copy) => copy.id));
      if (batchIds.length) {
        let batchFailed = false;
        for (const action of [() => this.host.purgeMedia(batchIds), () => this.host.purgeRouting(batchIds)]) {
          try {
            await action();
          } catch (error) {
            failures.push(error);
            batchFailed = true;
            console.warn('对话批量清理失败：', error);
          }
        }
        if (batchFailed) completed.length = 0;
      }
      if (cleanups.length)
        await this.host.finished([...new Set(cleanups.flatMap((item) => item.copies.map((copy) => copy.projectId)))]);
      for (const id of completed)
        store.db.prepare("DELETE FROM workspace_records WHERE kind='conversation-purge' AND id=?").run(id);
      if (failures.length) throw new AggregateError(failures, '部分对话副本未能清空，再次清空可重试。');
      return result;
    } finally {
      this.busy = false;
    }
  }
}

/** Shared database-only deletion; callers own their different file and project lifecycles. */
export function removeConversationRecords(store: WorkspaceStore, ids: string[]) {
  if (!ids.length) return;
  const { db } = store;
  const workflows = ids.flatMap((id) => store.conversationWorkflows(id));
  const workflowIds = JSON.stringify(workflows.map((workflow) => workflow.id));
  const runIds = JSON.stringify(workflows.flatMap((workflow) => workflow.runIds ?? []));
  const conversationIds = JSON.stringify(ids);
  const runs = db
    .prepare(
      "SELECT id, json_extract(value,'$.nativeSessionId') AS session FROM runs WHERE json_extract(value,'$.workflowId') IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?))",
    )
    .all(workflowIds, runIds) as { id: string; session: unknown }[];
  const exclude = db.prepare(
    "INSERT OR IGNORE INTO workspace_records(kind,id,owner,updated_at,value) VALUES('native-session-exclusion',?,'native-session-exclusions','','{}')",
  );
  for (const run of runs) if (typeof run.session === 'string' && run.session) exclude.run(run.session.toLowerCase());
  const allRuns = JSON.stringify([...new Set([...(JSON.parse(runIds) as string[]), ...runs.map((run) => run.id)])]);
  db.prepare('DELETE FROM run_audit_events WHERE run_id IN (SELECT value FROM json_each(?))').run(allRuns);
  deleteTraceContextRows(db, JSON.parse(allRuns) as string[]);
  db.prepare('DELETE FROM runs WHERE id IN (SELECT value FROM json_each(?))').run(allRuns);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_judgments'").get())
    db.prepare('DELETE FROM task_judgments WHERE workflow_id IN (SELECT value FROM json_each(?))').run(workflowIds);
  db.prepare('DELETE FROM workspace_records WHERE owner IN (SELECT value FROM json_each(?))').run(
    JSON.stringify([...ids, ...workflows.map((workflow) => workflow.id)]),
  );
  db.prepare("DELETE FROM workspace_records WHERE kind='worklog' AND id IN (SELECT value FROM json_each(?))").run(
    workflowIds,
  );
  db.prepare("DELETE FROM workspace_records WHERE kind='conversation' AND id IN (SELECT value FROM json_each(?))").run(
    conversationIds,
  );
  db.prepare(
    "DELETE FROM workspace_records WHERE kind='claude-history-import' AND json_extract(value,'$.conversationId') IN (SELECT value FROM json_each(?))",
  ).run(conversationIds);
}
