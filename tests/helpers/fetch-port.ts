import { createServer, type RequestListener, type Server } from 'node:http';
import { listenLoopback } from '../../src/server/platform/loopback-port.ts';

export { fetchPortAllowed } from '../../src/server/platform/loopback-port.ts';

/**
 * Bind an OS-assigned loopback port that Fetch can use, keeping it reserved by this server.
 * Pass a server, or a request handler such as an Express app to serve it on a new one.
 */
export async function listenForFetch(target: Server | RequestListener) {
  const server = typeof target === 'function' ? createServer(target) : target;
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    listenLoopback(server, 0, () => {
      server.off('error', fail);
      done();
    });
  });
  return server;
}
