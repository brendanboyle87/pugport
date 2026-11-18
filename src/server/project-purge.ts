import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Conversation, Project, Workflow } from '../shared/types.ts';
import type { ProjectPurgePreview, ProjectPurgeResult } from '../shared/project-data.ts';
import type { Routine } from '../shared/scheduled-tasks.ts';
import { realpathSync } from 'node:fs';
import type { WorkspaceStore } from './workspace-store.ts';
import type { ConversationCleanup } from './conversation-purge.ts';
import { memoryProjectDirectory, memoryStorageRoot } from './local-memory.ts';
import { memoryVectorCleanupPaths, withProjectVectorCleanup } from './memory-vectors.ts';
import { deleteTraceContextRows } from './trace-context-records.ts';
import { trustedDirectory } from './platform/trusted-path.ts';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const fold = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const canonical = (path: string) => {
  try {
    return fold(realpathSync.native(path));
  } catch {
    return fold(path);
  }
};
export const inside = (root: string, path: string) => {
  const part = relative(fold(root), fold(path));
  return !part || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part));
};
const info = async (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
export type PurgeTarget = { root: string; path: string };
type Target = PurgeTarget;
type AttachmentRow = { fileName: string; destinationFileName?: string; fitted?: { fileName: string } };
type Scope = {
  project: Project;
  conversations: Conversation[];
  conversationIds: string[];
  workflows: Workflow[];
  runIds: string[];
  routines: Routine[];
  rows: { kind: string; id: string; owner: string; value: string; updated_at: string }[];
  targets: Target[];
  attachments: number;
  sharedFilesKept: number;
  warnings: string[];
  token: string;
};
type Host = {
  store: WorkspaceStore;
  dataDir: string;
  assertIdle(project: Project, ids: string[]): void;
  quiesce(projectId: string): Promise<void>;
  purgeMedia(ids: string[]): void;
  purgeTraining?(projectId: string): Promise<void>;
  finished(): void;
};

/** Never follow a root redirect or a descendant link while permanently removing app-owned copies. */
async function validate(target: Target, parent = dirname(target.path)) {
  if (!isAbsolute(target.root) || fold(target.root) === fold(parse(target.root).root) || !inside(target.root, parent))
    throw Error('应用数据路径越界，未清空。');
  const chain: string[] = [];
  for (let current = resolve(parent); ; current = dirname(current)) {
    chain.push(current);
    if (current === dirname(current)) break;
  }
  for (const path of chain.reverse()) {
    const value = await info(path);
    if (!value) return;
    if (!value.isDirectory() || value.isSymbolicLink() || fold(await realpath(path)) !== fold(path))
      throw Error('应用数据目录包含链接或发生变化，未继续清空。');
  }
}

export async function visit(target: Target, remove: boolean): Promise<{ files: number; bytes: number }> {
  await validate(target);
  const entry = await info(target.path);
  if (!entry) return { files: 0, bytes: 0 };
  if (entry.isSymbolicLink()) {
    if (remove) await unlink(target.path);
    return { files: 1, bytes: 0 };
  }
  if (entry.isFile()) {
    if (remove) await unlink(target.path);
    return { files: 1, bytes: entry.size };
  }
  if (!entry.isDirectory()) throw Error('应用数据中存在不能安全清空的特殊文件。');
  if (fold(await realpath(target.path)) !== fold(target.path)) throw Error('应用数据目录发生变化，未继续清空。');
  const total = { files: 0, bytes: 0 };
  for (const name of await readdir(target.path)) {
    const current = await visit({ root: target.root, path: join(target.path, name) }, remove);
    total.files += current.files;
    total.bytes += current.bytes;
  }
  if (remove) {
    await validate(target);
    const current = await info(target.path);
    if (!current?.isDirectory() || current.isSymbolicLink() || fold(await realpath(target.path)) !== fold(target.path))
      throw Error('应用数据目录在清空期间发生变化，请重试。');
    await rmdir(target.path);
  }
  return total;
}

/** Permanent purge is distinct from reversible removal; a durable marker prevents restoring partial data. */
export class ProjectPurger {
  private busy = false;
  private purgeGeneration = 0;
  constructor(private host: Host) {}
  get inProgress() {
    return this.busy;
  }
  get generation() {
    return this.purgeGeneration;
  }

  private async protectOriginalFolders(scope: Scope) {
    const workspaceRoot = join(this.host.dataDir, 'workspaces');
    const originals = this.host.store
      .projects(true)
      .filter(
        (project) =>
          !(
            project.scope === 'chat' &&
            uuid.test(project.path.split(/[\\/]/).at(-1) ?? '') &&
            fold(project.path) === fold(join(workspaceRoot, project.path.split(/[\\/]/).at(-1)!))
          ),
      );
    for (const project of originals) {
      const aliases = [resolve(project.path), await realpath(project.path).catch(() => resolve(project.path))];
      for (const target of scope.targets)
        if (aliases.some((original) => inside(original, target.path) || inside(target.path, original)))
          throw Error('待清空数据与已关联的原项目文件夹重叠，原文件夹已保留，未执行清空。');
    }
  }

  private scope(id: string): Scope {
    const { store, dataDir } = this.host;
    const project = store.get<Project>('project', id);
    if (!project?.removedAt) throw Error('只能清空已从列表移除的项目。');
    if (!uuid.test(id)) throw Error('项目标识无效，不能清空本地目录。');
    const conversations = store.list<Conversation>('conversation', id, Number.MAX_SAFE_INTEGER);
    if (conversations.some((item) => !uuid.test(item.id))) throw Error('对话标识无效，不能清空本地目录。');
    const ids = conversations.map((item) => item.id);
    const workflows = conversations.flatMap((item) => store.conversationWorkflows(item.id));
    const owners = [id, ...ids, ...workflows.map((item) => item.id)];
    const rows = store.db
      .prepare(
        `SELECT kind,id,owner,value,updated_at FROM workspace_records
      WHERE owner IN (SELECT value FROM json_each(?)) AND kind NOT IN ('project-purge','hindsight-retired-bank','hindsight-generation','routine') ORDER BY kind,id`,
      )
      .all(JSON.stringify(owners)) as Scope['rows'];
    const pendingCopies = rows
      .filter((row) => row.kind === 'conversation-purge')
      .flatMap((row) => (JSON.parse(row.value) as ConversationCleanup).copies);
    if (pendingCopies.some((copy) => !uuid.test(copy.id) || copy.projectId !== id))
      throw Error('对话清理记录的标识无效。');
    const conversationIds = [...new Set([...ids, ...pendingCopies.map((copy) => copy.id)])];
    this.host.assertIdle(project, conversationIds);
    const attachments = rows.filter((row) => row.kind === 'attachment');
    const names = (row: AttachmentRow) => [
      row.fileName,
      ...(row.fitted ? [row.fitted.fileName] : []),
      ...(row.destinationFileName ? [row.destinationFileName] : []),
    ];
    const uploads = rows.filter((row) => row.kind === 'attachment-upload');
    const requested = new Set(
      [...attachments, ...uploads]
        .flatMap((row) => names(JSON.parse(row.value)))
        .concat(pendingCopies.flatMap((copy) => copy.attachments)),
    );
    if ([...requested].some((name) => !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/.test(name))) throw Error('附件存储路径无效。');
    const shared = new Set(
      store.db
        .prepare(
          "SELECT value FROM workspace_records WHERE kind='attachment' AND owner NOT IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify(ids))
        .flatMap((row) => names(JSON.parse(String(row.value)))),
    );
    const targets: Target[] = [];
    const own = (root: string, path: string) => {
      // Links above each storage root belong to the system (macOS /var): validate() checks every folder of the
      // real location, from the root down. Windows keeps the paths as given.
      const given = resolve(root);
      const base = resolve(trustedDirectory(given));
      targets.push({ root: base, path: base === given ? resolve(path) : join(base, relative(given, resolve(path))) });
    };
    const memoryRoot = memoryStorageRoot(dataDir);
    own(memoryRoot, memoryProjectDirectory(dataDir, id));
    own(join(dataDir, 'lane-events'), join(dataDir, 'lane-events', `${id}.jsonl`));
    for (const conversationId of conversationIds) {
      own(join(dataDir, 'member-results'), join(dataDir, 'member-results', conversationId));
      own(join(dataDir, 'workspaces', 'missing-folder'), join(dataDir, 'workspaces', 'missing-folder', conversationId));
    }
    for (const name of requested)
      if (!shared.has(name)) own(join(dataDir, 'attachments'), join(dataDir, 'attachments', name));
    const vectors = memoryVectorCleanupPaths(id);
    for (const path of vectors.paths) own(vectors.root, path);
    const warnings: string[] = [];
    const hasManagedChildren = workflows.some((workflow) => workflow.executionWorkspaceId);
    if (hasManagedChildren) warnings.push('子任务的独立 Git 工作目录和注册记录已保留，请确认交付结果后再手动清理。');
    const workspaceRoot = join(dataDir, 'workspaces');
    if (
      project.scope === 'chat' &&
      uuid.test(project.path.split(/[\\/]/).at(-1) ?? '') &&
      fold(project.path) === fold(join(workspaceRoot, project.path.split(/[\\/]/).at(-1)!))
    ) {
      if (hasManagedChildren) warnings.push('该工作目录可能保存子任务依赖的 Git 仓库，已保留以免损坏子任务文件。');
      else if (
        store
          .projects(true)
          .some((other) => other.id !== id && (inside(project.path, other.path) || inside(other.path, project.path)))
      )
        warnings.push('另一个项目也使用该托管工作目录，目录已保留。');
      else own(workspaceRoot, project.path);
    }
    const history = store.get<{ attempts?: { projectId: string; runId?: string }[] }>(
      'memory-distillation-history',
      'global',
    );
    const standalone = [
      ...(history?.attempts ?? []).filter((attempt) => attempt.projectId === id).map((attempt) => attempt.runId),
      ...rows
        .filter((row) => row.kind === 'taste-test')
        .flatMap((row) => {
          const value = JSON.parse(row.value) as { candidates?: { runId?: string }[] };
          return value.candidates?.map((candidate) => candidate.runId) ?? [];
        }),
    ].filter((runId): runId is string => typeof runId === 'string' && !!runId);
    const runIds = [...new Set([...workflows.flatMap((item) => item.runIds ?? []), ...standalone])].sort();
    const routines = store
      .list<Routine>('routine', undefined, Number.MAX_SAFE_INTEGER)
      .filter(
        (routine) =>
          routine.projectId === id ||
          (routine.projectPath && canonical(routine.projectPath) === canonical(project.path)),
      );
    const token = createHash('sha256')
      .update(JSON.stringify({ project, rows, targets, runIds, routines }))
      .digest('hex');
    return {
      project,
      conversations,
      conversationIds,
      workflows,
      runIds,
      routines,
      rows,
      targets,
      attachments: attachments.length,
      sharedFilesKept: [...requested].filter((name) => shared.has(name)).length,
      warnings,
      token,
    };
  }

  async preview(id: string): Promise<ProjectPurgePreview> {
    const project = this.host.store.get<Project>('project', id);
    if (!project?.removedAt) throw Error('只能清空已从列表移除的项目。');
    const value: ProjectPurgePreview = {
      projectId: id,
      name: project.name,
      token: '',
      conversations: 0,
      attachments: 0,
      managedFiles: 0,
      managedBytes: 0,
      preservedProjectPath: project.path,
      canPurge: false,
      partial: !!this.host.store.get('project-purge', id),
    };
    try {
      if (this.busy) throw Error('另一个项目正在清空，请完成后再试。');
      const scope = this.scope(id);
      await this.protectOriginalFolders(scope);
      value.token = scope.token;
      value.conversations = scope.conversations.length;
      value.attachments = scope.attachments;
      value.scheduledTasks = scope.routines.filter((routine) => routine.enabled).length;
      if (scope.targets.some((target) => fold(target.path) === fold(project.path))) {
        value.preservedProjectPath = '';
        value.managedWorkspacePath = project.path;
      }
      for (const target of scope.targets) {
        const current = await visit(target, false);
        value.managedFiles += current.files;
        value.managedBytes += current.bytes;
      }
      value.canPurge = true;
    } catch (error) {
      value.blockedReason = error instanceof Error ? error.message : '无法确认清空范围，请重试。';
    }
    return value;
  }

  async purge(id: string, token: string): Promise<ProjectPurgeResult> {
    if (this.busy) throw Error('另一个项目正在清空，请完成后再试。');
    const first = this.scope(id);
    if (!token || token !== first.token) throw Error('项目数据已有变化，请重新查看清空范围。');
    this.busy = true;
    this.purgeGeneration++;
    try {
      await this.protectOriginalFolders(first);
      for (const target of first.targets) await visit(target, false);
      if (this.scope(id).token !== token) throw Error('项目数据已有变化，请重新查看清空范围。');
      this.host.store.save('project-purge', id, id, { startedAt: new Date().toISOString() });
      await this.host.quiesce(id);
      return await withProjectVectorCleanup(id, async () => {
        const current = this.scope(id);
        await this.protectOriginalFolders(current);
        const result: ProjectPurgeResult = {
          projectId: id,
          conversations: current.conversations.length,
          attachments: current.attachments,
          deletedFiles: 0,
          freedBytes: 0,
          sharedFilesKept: current.sharedFilesKept,
          databaseSpace: 'reusable',
          ...(current.warnings.length ? { warnings: current.warnings } : {}),
        };
        // Preflight every root before the first deletion; partial failures retain the retry marker and records.
        for (const target of current.targets) await visit(target, false);
        for (const target of current.targets) {
          const removed = await visit(target, true);
          result.deletedFiles += removed.files;
          result.freedBytes += removed.bytes;
        }
        this.host.purgeMedia(current.conversationIds);
        await this.host.purgeTraining?.(id);
        this.host.assertIdle(current.project, current.conversationIds);
        result.scheduledTasks = this.host.store.transaction(() => this.deleteRecords(current));
        this.host.finished();
        return result;
      });
    } finally {
      this.busy = false;
    }
  }

  private deleteRecords(scope: Scope) {
    const { db } = this.host.store;
    let scheduledTasks = 0;
    for (const planned of scope.routines) {
      const current = this.host.store.get<Routine>('routine', planned.id);
      if (!current?.enabled || current.projectPath !== planned.projectPath || current.projectId !== planned.projectId)
        continue;
      current.enabled = false;
      this.host.store.save('routine', current.id, current.id, current);
      scheduledTasks++;
    }
    const workflowIds = scope.workflows.map((item) => item.id);
    const runIds = scope.runIds;
    const runs = db
      .prepare(
        "SELECT id,value FROM runs WHERE id IN (SELECT value FROM json_each(?)) OR json_extract(value,'$.workflowId') IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(runIds), JSON.stringify(workflowIds));
    for (const row of runs) {
      const session = JSON.parse(String(row.value)).nativeSessionId;
      if (typeof session === 'string' && session)
        this.host.store.save('native-session-exclusion', session.toLowerCase(), 'native-session-exclusions', {});
      db.prepare('DELETE FROM run_audit_events WHERE run_id=?').run(row.id);
      db.prepare('DELETE FROM runs WHERE id=?').run(row.id);
    }
    deleteTraceContextRows(db, [...runIds, ...runs.map((row) => String(row.id))]);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_judgments'").get())
      db.prepare('DELETE FROM task_judgments WHERE workflow_id IN (SELECT value FROM json_each(?))').run(
        JSON.stringify(workflowIds),
      );
    for (const row of scope.rows)
      db.prepare('DELETE FROM workspace_records WHERE kind=? AND id=?').run(row.kind, row.id);
    db.prepare("DELETE FROM workspace_records WHERE kind='project-purge' AND id=?").run(scope.project.id);
    return scheduledTasks;
  }
}
