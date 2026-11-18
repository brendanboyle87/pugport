import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from './workspace-store.ts';
import { indexMemory } from './memory-vectors.ts';
import type { MemoryVectorJob } from './memory-vector-client.ts';

const job = workerData.job as MemoryVectorJob;
process.env.COMBORUNNER_MEMORY_VECTORS_DIR = job.vectorDirectory;
const db = new DatabaseSync(job.databasePath, { readOnly: true });
db.exec('PRAGMA busy_timeout=1000');
try {
  const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
  const remaining = await indexMemory(job.appRoot, store, job.projectId, { until: job.until });
  parentPort?.postMessage({ remaining });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  db.close();
}
