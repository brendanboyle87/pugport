import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenLoopback } from '../server/platform/loopback-port.ts';

/** Probe only; the owned child must still bind this exact port and complete its IPC handshake. */
export function probeLoopbackPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    listenLoopback(server, port, () => {
      const selected = (server.address() as AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

export async function selectDesktopPort(
  env: NodeJS.ProcessEnv = process.env,
  probe: (port: number) => Promise<number> = probeLoopbackPort,
  {
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => performance.now(),
  }: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
) {
  const explicit = env.COMBORUNNER_PORT || env.AGENT_STUDIO_PORT;
  const port = Number(explicit || 4317);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('本地后台端口必须介于 1 与 65535 之间。');
  const deadline = now() + 12_000;
  let waited = false;
  for (;;) {
    try {
      return await probe(port);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (explicit || (code !== 'EACCES' && code !== 'EADDRINUSE')) throw error;
      const remaining = deadline - now();
      if (code !== 'EADDRINUSE' || remaining <= 0) return probe(0);
      if (!waited) console.warn(`Port ${port} is busy; waiting up to 12 s for it before using another port.`);
      waited = true;
      await sleep(Math.min(500, remaining));
    }
  }
}
