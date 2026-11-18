import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from './workspace-store.ts';
import { retrieveLocalMemory, type RetrievalInput, type RetrievedMemory } from './memory-retrieval.ts';
import { closeProjectMemoryIndexes, projectMemoryIndex } from './memory-index.ts';

const db = new DatabaseSync(workerData.databasePath as string, { readOnly: true });
db.exec('PRAGMA busy_timeout=1000');
const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
let closing = false;
const activeWork = new Set<Promise<unknown>>();

function trackWork(promise: Promise<unknown>) {
  activeWork.add(promise);
  void promise.finally(() => activeWork.delete(promise));
}

parentPort?.on('message', (message: { id: number; input: RetrievalInput } | { type: 'close' }) => {
  if ('type' in message) {
    closing = true;
    void (async () => {
      await closeProjectMemoryIndexes(store);
      await Promise.allSettled([...activeWork]);
      try {
        if (db.isOpen) db.close();
      } catch {
        /* Read-only worker connection may already be closed. */
      }
      parentPort?.postMessage({ type: 'closed' });
      parentPort?.close();
    })();
    return;
  }
  if (closing || !db.isOpen) {
    parentPort?.postMessage({
      id: message.id,
      result: { context: '', excerpts: [], paths: [], elapsedMs: 0, error: '本地历史检索已关闭。' },
    });
    return;
  }
  const job = message;
  const run = (async () => {
    let result: RetrievedMemory;
    const index = projectMemoryIndex(store, job.input.projectId);
    try {
      result = await retrieveLocalMemory(store, job.input, { inline: true, direct: !index.isReady });
    } catch (error) {
      result = {
        context: '',
        excerpts: [],
        paths: [],
        elapsedMs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    parentPort?.postMessage({ id: job.id, result });
    if (!closing && db.isOpen) {
      const warm = index.warm().catch(() => {
        /* Direct evidence remains available; a failed warm never fails a task. */
      });
      trackWork(warm);
      await warm;
    }
  })();
  trackWork(run);
});
