import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Project } from '../shared/types.ts';
import { WorkspaceStore } from './workspace-store.ts';
import { refreshLocalMemory } from './local-memory-runtime.ts';
import { installLocalMemoryBootstrap, uninstallLocalMemoryBootstrap } from './local-memory-bootstrap.ts';
import type { MemoryJob, MemoryResult } from './local-memory-scheduler.ts';

// All filesystem serialization and Git work happens here, never on the HTTP/event loop.
parentPort?.on('message', (job: MemoryJob | { type: 'close' }) => {
  if ('type' in job) {
    parentPort?.postMessage({ type: 'closed' });
    parentPort?.close();
    return;
  }
  const result: MemoryResult = { projectId: job.projectId, files: [], warnings: [] };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(job.dataDir, 'studio.sqlite'), { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
    const project = store.get<Project>('project', job.projectId);
    if (!project || project.removedAt) throw Error('本地记忆所属项目不存在或已移除。');
    if (job.configure && project.localMemory?.cliEnabled !== true) {
      const rules = uninstallLocalMemoryBootstrap(project.path);
      result.files.push(...rules.files);
      result.warnings.push(...rules.warnings);
    }
    if (job.all || !job.conversationIds.length) {
      result.warnings.push(...refreshLocalMemory(store, project, job.dataDir, job.appRoot));
    } else {
      for (const conversationId of job.conversationIds)
        result.warnings.push(...refreshLocalMemory(store, project, job.dataDir, job.appRoot, conversationId));
    }
    if (job.configure && project.localMemory?.cliEnabled === true) {
      result.cliInstalled = false;
      if (!result.warnings.length) {
        const rules = installLocalMemoryBootstrap(project.path);
        result.files.push(...rules.files);
        result.warnings.push(...rules.warnings);
        result.cliInstalled = !rules.warnings.length;
      } else result.warnings.push('本地副本未成功更新，未安装 CLI 记忆指引。');
    }
  } catch (error) {
    result.warnings.push(error instanceof Error ? error.message : String(error));
  } finally {
    db?.close();
  }
  result.warnings = [...new Set(result.warnings)];
  parentPort?.postMessage({ id: job.id, ...result });
});
