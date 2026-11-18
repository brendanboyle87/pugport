import { join, resolve } from 'node:path';
import { syncLocalMemory, notifyLocalWorkspace } from '../src/server/local-memory-cli.ts';
import { resolveDataLocation } from '../src/shared/data-location.ts';

const root = resolve(import.meta.dirname, '..');
const data = resolveDataLocation({ root }).dataDir;
const argument = process.argv[2];
if (!argument) throw Error('Usage: node --import tsx scripts/sync-local-memory.ts <project-id-or-path|--all>');
if (argument === '--all') {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(data, 'studio.sqlite'), { readOnly: true });
  const rows = database.prepare("SELECT id FROM workspace_records WHERE kind='project'").all() as { id: string }[];
  database.close();
  for (const row of rows) console.log(JSON.stringify(syncLocalMemory(row.id, root, data)));
} else console.log(JSON.stringify(syncLocalMemory(argument, root, data)));
await notifyLocalWorkspace(data);
