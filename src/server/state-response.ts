import type { RequestHandler, Response } from 'express';
import type { Controller } from './controller.ts';

// Start before authentication and parsers; no request headers or state contents enter logs.
export const timeStateRequest: RequestHandler = (req, res, next) => {
  if (req.method === 'GET' && req.path === '/api/state') res.locals.stateRequestStarted = performance.now();
  next();
};

export function sendStateResponse(
  res: Response,
  controller: Pick<Controller, 'recentState' | 'recentStateJson'>,
  refresh: () => void,
) {
  const entered = performance.now();
  const started: number = res.locals.stateRequestStarted ?? entered;
  refresh();
  const refreshed = performance.now();
  controller.recentState();
  const built = performance.now();
  const json = controller.recentStateJson();
  const serialized = performance.now();
  const phases = {
    middleware: entered - started,
    folders: refreshed - entered,
    state: built - refreshed,
    json: serialized - built,
  };
  res.setHeader(
    'Server-Timing',
    Object.entries(phases)
      .map(([name, ms]) => `${name};dur=${ms.toFixed(2)}`)
      .join(', '),
  );
  let sent = serialized;
  res.once('finish', () => {
    const finished = performance.now();
    if (finished - started >= 1000)
      console.warn(
        '[slow-state-http] ' +
          JSON.stringify({
            ...phases,
            send: sent - serialized,
            flush: finished - sent,
            total: finished - started,
            bytes: res.getHeader('Content-Length'),
          }),
      );
  });
  res.type('json').send(json);
  sent = performance.now();
}
