import type { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ssePendingBytesLimit = 8 * 1024 * 1024;
export const sseStallMs = 60_000;
const stateEvents = new WeakMap<object, string>();
function stateEvent(value: object) {
  let text = stateEvents.get(value);
  if (text === undefined) stateEvents.set(value, (text = `event: state\ndata: ${JSON.stringify(value)}\n\n`));
  return text;
}

/** One latest state per reader; run deltas are recoverable from the next full state. */
export function connectEventStream(req: IncomingMessage, res: ServerResponse, source: EventEmitter, initial: object) {
  let full = false;
  let closed = false;
  let pendingState: string | undefined;
  let pendingBytes = 0;
  const pendingRuns: string[] = [];
  let stall: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(stall);
    source.off('state', state);
    source.off('run', run);
    res.off('drain', drain);
    res.off('close', cleanup);
    req.off('close', cleanup);
    pendingState = undefined;
    pendingRuns.length = 0;
    pendingBytes = 0;
  };
  const end = () => {
    cleanup();
    res.end();
    // end() alone waits for buffered bytes; a stalled socket must release them immediately.
    res.destroy();
  };
  const write = (text: string) => {
    full = !res.write(text);
    // Include the already accepted socket buffer: a reader that never drains must expire too.
    if (full && !stall) stall = setTimeout(end, sseStallMs);
  };
  const trim = () => {
    while (pendingRuns.length && (pendingBytes > ssePendingBytesLimit || pendingRuns.length > 2000))
      pendingBytes -= Buffer.byteLength(pendingRuns.shift()!);
    // Never truncate a full state. An oversized pending snapshot is recovered on reconnect.
    if (pendingBytes > ssePendingBytesLimit) end();
  };
  const state = (value: object) => {
    if (closed) return;
    const text = stateEvent(value);
    if (!full) write(text);
    else {
      pendingBytes -= pendingState ? Buffer.byteLength(pendingState) : 0;
      pendingState = text;
      pendingBytes += Buffer.byteLength(text);
      trim();
    }
  };
  const run = (value: unknown) => {
    if (closed) return;
    const text = `event: run\ndata: ${JSON.stringify(value)}\n\n`;
    if (!full) write(text);
    else {
      pendingRuns.push(text);
      pendingBytes += Buffer.byteLength(text);
      trim();
    }
  };
  const drain = () => {
    clearTimeout(stall);
    stall = undefined;
    full = false;
    if (pendingState) {
      const text = pendingState;
      pendingState = undefined;
      pendingBytes -= Buffer.byteLength(text);
      write(text);
    }
    while (!full && pendingRuns.length) {
      const text = pendingRuns.shift()!;
      pendingBytes -= Buffer.byteLength(text);
      write(text);
    }
  };
  const heartbeat = setInterval(() => {
    if (!full) write(': heartbeat\n\n');
  }, 15000);
  res.on('drain', drain);
  res.on('close', cleanup);
  req.on('close', cleanup);
  source.on('state', state);
  source.on('run', run);
  state(initial);
  return () => ({ pendingStates: pendingState ? 1 : 0, pendingRuns: pendingRuns.length, pendingBytes, closed });
}
