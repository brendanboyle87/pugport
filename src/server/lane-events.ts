import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export type LaneEventType =
  | 'lane-created'
  | 'turn-settled'
  | 'pushed'
  | 'pr-opened'
  | 'pr-merged'
  | 'archived'
  | 'worktree-removed'
  | 'worktree-kept';
export type LaneEvent = {
  at: string;
  type: LaneEventType;
  lane: string;
  title?: string;
  workflowId?: string;
  branch?: string;
  sha?: string;
  number?: number;
  url?: string;
  repository?: string;
  status?: 'completed' | 'failed';
  reason?: string;
};
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function laneEventsPath(dataDir: string, projectId: string): string {
  if (!uuid.test(projectId)) throw Error('Invalid project ID');
  return join(dataDir, 'lane-events', `${projectId}.jsonl`);
}
export function appendLaneEvent(dataDir: string | undefined, projectId: string, event: LaneEvent): void {
  if (!dataDir || !uuid.test(projectId)) return;
  try {
    mkdirSync(join(dataDir, 'lane-events'), { recursive: true });
    appendFileSync(laneEventsPath(dataDir, projectId), `${JSON.stringify(event)}\n`);
  } catch {
    /* Logging must not interrupt the task. */
  }
}
export function readLaneEvents(
  dataDir: string | undefined,
  projectId: string,
  filter?: { lane?: string; limit?: number },
): LaneEvent[] {
  if (!dataDir || !uuid.test(projectId)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(laneEventsPath(dataDir, projectId), 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, count).toString('utf8').split('\n');
    if (start) lines.shift();
    const events: LaneEvent[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as LaneEvent;
        if (
          event &&
          typeof event === 'object' &&
          typeof event.at === 'string' &&
          typeof event.type === 'string' &&
          typeof event.lane === 'string' &&
          (!filter?.lane || event.lane === filter.lane)
        )
          events.push(event);
      } catch {
        /* Ignore malformed or incomplete lines. */
      }
    }
    if (filter?.limit === undefined) return events;
    const limit = Math.max(0, Math.floor(filter.limit));
    return limit ? events.slice(-limit) : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
