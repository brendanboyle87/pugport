import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { WorkspaceStore } from './workspace-store.ts';
import { syncGrokHistory } from './grok-history-sync.ts';
import type { GrokHistoryWorkerMessage, GrokHistoryWorkerReply } from './grok-history-worker-client.ts';

parentPort?.on('message', (job: GrokHistoryWorkerMessage) => {
  const reply: GrokHistoryWorkerReply = { id: job.id };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(job.dataDir, 'studio.sqlite'));
    db.exec('PRAGMA busy_timeout=2000');
    // The app owns initialization/recovery. This worker must never mark live tasks interrupted.
    const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
    reply.result = syncGrokHistory(store, job.dataDir, job.projectId, {
      grokHomes: job.grokHomes,
      now: job.now,
      force: job.force,
    });
  } catch (error) {
    reply.error = error instanceof Error ? error.message : 'Grok 历史同步失败；已有记录仍保留。';
  } finally {
    db?.close();
  }
  parentPort?.postMessage(reply);
});
