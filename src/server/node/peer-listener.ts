import { createServer, type RequestListener, type Server } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** "::ffff:100.64.1.2" (an IPv4 client on a dual-stack socket) is 100.64.1.2; a zone id is dropped. */
export function normalizeAddress(address: string): string {
  const plain = address.trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
  return mapped ? mapped[1]! : plain;
}

/** Tailscale's addresses: 100.64.0.0/10 (IPv4) and fd7a:115c:a1e0::/48 (IPv6). */
export function isTailscaleAddress(address: string): boolean {
  const value = normalizeAddress(address);
  if (isIPv4(value)) {
    const [first, second] = value.split('.').map(Number);
    return first === 100 && second! >= 64 && second! <= 127;
  }
  return isIPv6(value) && value.startsWith('fd7a:115c:a1e0:');
}

export function isLoopbackAddress(address: string): boolean {
  const value = normalizeAddress(address);
  return (isIPv4(value) && value.startsWith('127.')) || value === '::1';
}

/** Only Tailscale peers; loopback too when the listener itself is bound to loopback (tests, a local tunnel). */
export function peerAddressAllowed(remote: string | undefined, allowLoopback: boolean): boolean {
  if (!remote) return false;
  return isTailscaleAddress(remote) || (allowLoopback && isLoopbackAddress(remote));
}

/** This machine's Tailscale IPv4 address, once tailscaled has brought the interface up. */
export function tailscaleAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | undefined {
  for (const list of Object.values(interfaces))
    for (const entry of list ?? [])
      if (entry.family === 'IPv4' && !entry.internal && isTailscaleAddress(entry.address)) return entry.address;
  return undefined;
}

export type PeerListenerState = {
  port: number;
  status: 'waiting' | 'listening' | 'error';
  /** The address it is bound to (or will bind to, when set explicitly). */
  host?: string;
  error?: string;
};

export type PeerListenerOptions = {
  handler: RequestListener;
  port: number;
  /** Bind here instead of the Tailscale address (PUGPORT_PEER_HOST, e.g. 127.0.0.1 for tests). */
  host?: string;
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** How long to wait before looking for the address again. */
  retryMs?: (attempt: number) => number;
  log?: (line: string) => void;
};

const defaultRetry = (attempt: number) => (attempt < 24 ? 5000 : 30_000);

/**
 * The node's second listener, separate from the 127.0.0.1 one the desktop and the terminal command use. A user
 * systemd unit cannot wait for the system's tailscaled, so this keeps looking for the Tailscale address and binds
 * as soon as it exists. Connections from anywhere else are dropped before a request is read.
 */
export class PeerListener {
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private attempt = 0;
  private closed = false;
  private current: PeerListenerState;
  private waitingLogged = false;

  constructor(private readonly options: PeerListenerOptions) {
    this.current = { port: options.port, status: 'waiting', ...(options.host ? { host: options.host } : {}) };
  }
  state(): PeerListenerState {
    return { ...this.current };
  }
  /** The port actually bound (differs from the requested one only when that was 0). */
  boundPort(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : undefined;
  }

  start() {
    this.listen();
  }

  private retry() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.listen(), (this.options.retryMs ?? defaultRetry)(this.attempt++));
    this.timer.unref();
  }

  private listen() {
    if (this.closed || this.server) return;
    const host = this.options.host ?? tailscaleAddress(this.options.interfaces?.());
    if (!host) {
      this.current = { port: this.options.port, status: 'waiting' };
      if (!this.waitingLogged) this.options.log?.('[peer] waiting for the Tailscale address');
      this.waitingLogged = true;
      return this.retry();
    }
    const allowLoopback = isLoopbackAddress(host);
    const server = createServer(this.options.handler);
    server.headersTimeout = 10_000;
    // Routes enforce body deadlines; steady file transfers have no total deadline.
    server.requestTimeout = 0;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 50;
    server.maxConnections = 64;
    server.on('connection', (socket) => {
      if (!peerAddressAllowed(socket.remoteAddress, allowLoopback)) socket.destroy();
    });
    server.once('error', (error: NodeJS.ErrnoException) => {
      server.close();
      this.current = { port: this.options.port, host, status: 'error', error: error.code ?? 'listen-failed' };
      this.options.log?.(`[peer] cannot listen on ${host}:${this.options.port} (${error.code ?? 'error'}); retrying`);
      this.retry();
    });
    server.listen(this.options.port, host, () => {
      if (this.closed) {
        server.close();
        return;
      }
      this.server = server;
      this.attempt = 0;
      this.current = { port: this.boundPort() ?? this.options.port, host, status: 'listening' };
      this.options.log?.(`[peer] listening on ${host.includes(':') ? `[${host}]` : host}:${this.current.port}`);
    });
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
}
