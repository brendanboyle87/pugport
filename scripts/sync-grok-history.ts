// Local-only incremental sync, usable while the desktop is open or closed. No inference or native session resume.
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Project } from '../src/shared/types.ts';
import { syncGrokHistory } from '../src/server/grok-history-sync.ts';
import { refreshLocalMemory } from '../src/server/local-memory-runtime.ts';
import { notifyLocalWorkspace } from '../src/server/local-memory-cli.ts';
import { resolveDataLocation } from '../src/shared/data-location.ts';

const root = resolve(import.meta.dirname, '..');
const data = resolveDataLocation({ root }).dataDir;
const projectArgument = process.argv[2];
if (!projectArgument)
  throw Error('Usage: node --import tsx scripts/sync-grok-history.ts <project-id-or-path> [grok-home]');
const db = new DatabaseSync(join(data, 'studio.sqlite'));
db.exec('PRAGMA busy_timeout=10000');
try {
  // Attaching an importer must never mark another running application's workflows as interrupted.
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const project = store
    .list<Project>('project', undefined, 2147483647)
    .find(
      (value) =>
        value.id === projectArgument || resolve(value.path).toLowerCase() === resolve(projectArgument).toLowerCase(),
    );
  if (!project) throw Error('请先在 PugPort 添加这个项目。');
  const result = syncGrokHistory(
    store,
    data,
    project.id,
    process.argv[3] ? { grokHomes: [resolve(process.argv[3])] } : {},
  );
  result.warnings.push(...refreshLocalMemory(store, project, data, root));
  result.warnings = [...new Set(result.warnings)];
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
await notifyLocalWorkspace(data);
