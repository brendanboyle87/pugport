import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Fetch and Chromium page loads refuse these ports before connecting ("bad port"), yet an OS can assign them to
// port 0: Windows hands out ports from 1024 when its dynamic range has been widened.
const blockedPorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const fetchPortAllowed = (port: number) => port >= 1024 && !blockedPorts.has(port);

/**
 * Listen on 127.0.0.1, then call `ready`. An automatic port (0) that Fetch or Chromium would refuse is given back
 * and another taken, so the app and its local clients can always reach it. Errors go to the server's 'error' event.
 */
export function listenLoopback(server: Server, port: number, ready: () => void) {
  server.listen(port, '127.0.0.1', () => {
    if (port === 0 && !fetchPortAllowed((server.address() as AddressInfo).port))
      return void server.close(() => listenLoopback(server, port, ready));
    ready();
  });
}
