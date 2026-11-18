import { parentPort } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';

// File reads and JSON conversion stay together: async readFile alone still parses on the HTTP thread.
parentPort!.on(
  'message',
  async (job: { id: number; file: string; value?: unknown; write?: boolean; exclusive?: boolean }) => {
    try {
      let value;
      if (job.write)
        await writeFile(job.file, JSON.stringify(job.value), { mode: 0o600, flag: job.exclusive ? 'wx' : 'w' });
      else value = JSON.parse(await readFile(job.file, 'utf8'));
      parentPort!.postMessage({ id: job.id, value });
    } catch (error) {
      parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
    }
  },
);
