import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../shared/types.ts';
import { exportConversationMemory, exportProjectMemory, writeMemorySyncHelper } from './local-memory.ts';
import type { WorkspaceStore } from './workspace-store.ts';

/** Local projection only: no model requests, quota reads or native session execution. */
export function refreshLocalMemory(
  store: WorkspaceStore,
  project: Project,
  dataDir: string,
  appRoot: string,
  conversationId?: string,
): string[] {
  const warnings: string[] = [];
  // Opt-out stops filesystem copies; the application's SQLite history is unaffected.
  if (project.localMemory?.exportEnabled === false) return warnings;
  try {
    warnings.push(
      ...(conversationId
        ? exportConversationMemory(store, project, conversationId, dataDir).warnings
        : exportProjectMemory(store, project, dataDir)),
    );
    const entry = join(appRoot, 'dist', 'server', 'local-memory-cli.js');
    if (project.localMemory?.cliEnabled === true && existsSync(entry)) {
      const bundledNode = join(appRoot, '.runtime', 'node.exe');
      writeMemorySyncHelper(
        project.path,
        existsSync(bundledNode) ? bundledNode : process.execPath,
        entry,
        dataDir,
        project.id,
      );
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  // No rule installation or DB writes here: worker readers and manual sync share this path.
  return [...new Set(warnings)];
}
