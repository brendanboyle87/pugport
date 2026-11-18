// Compatibility entry point. Register a new project if needed, then use the incremental merged-history service.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readSessionToken } from '../src/server/platform/desktop-endpoint.ts';
import { resolveDataLocation } from '../src/shared/data-location.ts';
if (!process.argv[2])
  throw Error('Usage: node --import tsx scripts/import-grok-history.ts <project-directory> [grok-home]');
const projectPath = realpathSync.native(resolve(process.argv[2]));
const root = resolve(import.meta.dirname, '..');
const data = resolveDataLocation({ root }).dataDir;
let registered = false;
if (existsSync(join(data, 'studio.sqlite'))) {
  const db = new DatabaseSync(join(data, 'studio.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT value FROM workspace_records WHERE kind='project'").all() as { value: string }[];
    registered = rows.some((row) => {
      const p = JSON.parse(row.value).path;
      return process.platform === 'win32'
        ? resolve(p).toLowerCase() === projectPath.toLowerCase()
        : resolve(p) === projectPath;
    });
  } finally {
    db.close();
  }
}
if (!registered) {
  const base = process.env.COMBORUNNER_IMPORT_URL ?? 'http://127.0.0.1:4317';
  const token = readSessionToken(Number(new URL(base).port || 80));
  if (!token) throw Error('Local session token unavailable.');
  const state = await fetch(base + '/api/state', {
    headers: { 'x-agent-token': token },
    signal: AbortSignal.timeout(3000),
  }).then((r) => r.json());
  if (resolve(state.app.dataDir).toLowerCase() !== data.toLowerCase())
    throw Error('Start the matching PugPort desktop first.');
  const response = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
    body: JSON.stringify({ path: projectPath, createDirectory: false }),
  });
  if (!response.ok) throw Error('Could not register project.');
}
process.argv[2] = projectPath;
await import('./sync-grok-history.ts');
