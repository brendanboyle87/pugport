// Explicit local maintenance command. Never called by startup or project instructions.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { migrateLegacyProjectMemory } from '../src/server/local-memory.ts';
import { uninstallLocalMemoryBootstrap } from '../src/server/local-memory-bootstrap.ts';
import type { Project } from '../src/shared/types.ts';
import { resolveDataLocation } from '../src/shared/data-location.ts';

const appRoot = resolve(import.meta.dirname, '..');
const dataDir = resolveDataLocation({ root: appRoot }).dataDir;
const argument = process.argv[2];
if (!argument || process.argv.length !== 3)
  throw Error('Usage: node --import tsx scripts/migrate-local-memory.ts <project-id-or-path|--all>');
const databasePath = join(dataDir, 'studio.sqlite');
if (!existsSync(databasePath)) throw Error('本地对话数据库不存在；未创建或迁移文件。');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA busy_timeout=5000');
try {
  const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
  const comparable = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  const projects = store
    .list<Project>('project', undefined, 2147483647)
    .filter(
      (project) => argument === '--all' || project.id === argument || comparable(project.path) === comparable(argument),
    );
  if (!projects.length) throw Error('请先在 PugPort 添加这个项目。');
  for (const project of projects) {
    // This explicit command disables the old project integration. Re-enrollment is a separate UI action.
    project.localMemory = { exportEnabled: project.localMemory?.exportEnabled !== false, cliEnabled: false };
    store.save('project', project.id, project.id, project);
    const migration = migrateLegacyProjectMemory(store, project, dataDir);
    const cleanup = uninstallLocalMemoryBootstrap(project.path);
    const warnings = [...new Set([...migration.warnings, ...cleanup.warnings])];
    store.save('local-memory-status', project.id, project.id, { files: cleanup.files, warnings });
    console.log(JSON.stringify({ projectId: project.id, ...migration, rulesRemoved: cleanup.files, warnings }));
    if (warnings.length) process.exitCode = 1;
  }
} finally {
  db.close();
}
