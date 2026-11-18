import './platform/under-test.ts';
// Compiled into dist/server/local-memory-cli.js; works without an open desktop or any provider request.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project } from '../shared/types.ts';
import { grokHistoryHomes, syncGrokHistory } from './grok-history-sync.ts';
import { refreshLocalMemory } from './local-memory-runtime.ts';
import { WorkspaceStore } from './workspace-store.ts';
import { resolveDataLocation } from '../shared/data-location.ts';
import { backendPort } from '../cli/client.ts';
import { readSessionToken } from './platform/desktop-endpoint.ts';

export function syncLocalMemory(projectArgument: string, root: string, data: string) {
  const database = join(data, 'studio.sqlite');
  if (!existsSync(database)) throw Error('本地对话数据库不存在；请先启动 PugPort 并添加项目。');
  const db = new DatabaseSync(database);
  db.exec('PRAGMA busy_timeout=5000');
  try {
    // A standalone reader/importer must never recover or interrupt another application's tasks.
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    const project = store
      .list<Project>('project', undefined, 2147483647)
      .find(
        (p) =>
          !p.removedAt &&
          (p.id === projectArgument ||
            (process.platform === 'win32'
              ? resolve(p.path).toLowerCase() === resolve(projectArgument).toLowerCase()
              : resolve(p.path) === resolve(projectArgument))),
      );
    if (!project) throw Error('请先在 PugPort 添加这个项目。');
    const warnings: string[] = [];
    let grok;
    const imports = db
      .prepare("SELECT 1 FROM workspace_records WHERE kind='grok-import' AND owner=? LIMIT 1")
      .get(project.id);
    const native =
      project.scope !== 'chat' &&
      grokHistoryHomes(store, project.id).some((home) =>
        existsSync(join(home, 'sessions', encodeURIComponent(project.path))),
      );
    if (project.scope !== 'chat' && (imports || native)) {
      try {
        grok = syncGrokHistory(store, data, project.id);
        warnings.push(...grok.warnings);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    warnings.push(...refreshLocalMemory(store, project, data, root));
    return {
      projectId: project.id,
      conversations: store.conversations(project.id).length,
      grok,
      warnings: [...new Set(warnings)],
    };
  } finally {
    db.close();
  }
}

/** Notify only the matching local desktop. No private history or token is sent to another server. */
export async function notifyLocalWorkspace(data: string, requestTimeoutMs = 1000) {
  if (!existsSync(join(data, 'server.lock'))) return;
  const timeout = () => AbortSignal.timeout(requestTimeoutMs);
  try {
    const base = new URL(process.env.COMBORUNNER_IMPORT_URL ?? `http://127.0.0.1:${backendPort()}`);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) return;
    const token = readSessionToken(Number(base.port));
    const state = await fetch(new URL('/api/state', base), {
      signal: timeout(),
      headers: token ? { 'x-agent-token': token } : {},
    }).then((r) => r.json());
    const observed = state.app?.dataDir;
    if (
      typeof observed !== 'string' ||
      (process.platform === 'win32'
        ? resolve(observed).toLowerCase() !== resolve(data).toLowerCase()
        : resolve(observed) !== resolve(data))
    )
      return;
    if (typeof token !== 'string') return;
    await fetch(new URL('/api/workspace/refresh', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
      body: '{}',
      signal: timeout(),
    });
  } catch {
    /* Saved records are durable; the next desktop launch reads them. */
  }
}

// Source imports are used by fixture tests and the thin scripts wrapper.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..', '..');
  try {
    const data = resolveDataLocation({ root }).dataDir;
    if (!process.argv[2]) throw Error('Usage: local-memory-cli.js <project-id-or-path>');
    console.log(JSON.stringify(syncLocalMemory(process.argv[2], root, data)));
    await notifyLocalWorkspace(data);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
