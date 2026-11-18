import type { Response } from 'express';

export async function sendMcpReply(
  res: Response,
  accept: string | undefined,
  call: (signal: AbortSignal) => Promise<{ status: number; body?: unknown }>,
  { streamAfterMs = 10_000, keepaliveMs = 25_000 } = {},
) {
  const abort = new AbortController();
  let streaming = false;
  let start: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const clearTimers = () => {
    clearTimeout(start);
    clearInterval(heartbeat);
  };
  res.on('close', () => {
    clearTimers();
    abort.abort();
  });
  if (accept?.split(',').some((type) => type.split(';')[0]!.trim().toLowerCase() === 'text/event-stream')) {
    // Send headers before HTTP clients' five-minute header timeout, even during owner approval.
    start = setTimeout(() => {
      if (res.destroyed || res.writableEnded) return;
      streaming = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
      res.write(': keepalive\n\n');
      heartbeat = setInterval(() => res.write(': keepalive\n\n'), keepaliveMs);
    }, streamAfterMs);
  }
  try {
    const reply = await call(abort.signal);
    if (res.destroyed || res.writableEnded) return;
    if (streaming) {
      if (reply.body !== undefined) res.write(`event: message\ndata: ${JSON.stringify(reply.body)}\n\n`);
      res.end();
    } else if (reply.body === undefined) res.status(reply.status).end();
    else res.status(reply.status).json(reply.body);
  } finally {
    clearTimers();
  }
}
