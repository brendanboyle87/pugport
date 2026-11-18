import { assertTestUrl } from '../platform/under-test.ts';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { z } from 'zod';
import { isLoopbackAddress, isTailscaleAddress, normalizeAddress } from '../node/peer-listener.ts';
import { defaultPeerPort } from '../node/peer-protocol.ts';

/** The device could not be reached at all (off, asleep, Tailscale down, wrong address). */
export class PeerUnreachable extends Error {}
/** Local cancellation cannot prove that an already accepted remote write has stopped. */
export class PeerOutcomeUnknown extends Error {}
export class PeerStopUnconfirmed extends PeerOutcomeUnknown {}
/** The device answered with an error; `message` is its own plain-language reason. */
export class PeerRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly notSent = false,
  ) {
    super(message);
  }
}

export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((entry) => entry.address);

export type PeerAddress = { host: string; port: number };

const hostname =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/**
 * "100.101.102.103", "100.101.102.103:4318", "[fd7a:115c:a1e0::1]:4318", "ubuntu", "ubuntu.tail1234.ts.net"; a
 * pasted "http://…/" around it is tolerated. Undefined when it is none of these.
 */
export function parsePeerAddress(text: string): PeerAddress | undefined {
  let value = text
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!value || value.length > 300 || /[\s/?#@]/.test(value)) return undefined;
  let port = defaultPeerPort;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value);
  if (bracketed) {
    value = bracketed[1]!;
    if (bracketed[2]) port = Number(bracketed[2]);
    if (isIP(value) !== 6) return undefined;
  } else if (isIP(value) === 6) {
    // A bare IPv6 address carries no port.
  } else {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(value);
    if (withPort) {
      value = withPort[1]!;
      port = Number(withPort[2]);
    }
    if (!isIP(value) && !hostname.test(value)) return undefined;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: value.toLowerCase().replace(/\.$/, ''), port };
}

export function formatPeerAddress(address: PeerAddress) {
  const host = address.host.includes(':') ? `[${address.host}]` : address.host;
  return address.port === defaultPeerPort ? host : `${host}:${address.port}`;
}

/** Only Tailscale (encrypted, and each address belongs to one of the user's machines) or this computer itself. */
const reachable = (ip: string) => isTailscaleAddress(ip) || isLoopbackAddress(ip);

/**
 * The address to connect to. A name is looked up every time and must lead to a Tailscale address, so the pairing
 * code, the token and the tasks never travel over a plain local network or the internet.
 */
export async function resolvePeer(address: PeerAddress, lookup: Lookup = systemLookup): Promise<PeerAddress> {
  if (isIP(address.host)) {
    if (!reachable(address.host))
      throw new PeerRefused(400, '只能连接 Tailscale 地址（100.x.x.x）或 Tailscale 里的设备名。');
    return address;
  }
  if (lookup === systemLookup) assertTestUrl(`http://${address.host}:${address.port}/`);
  let found: string[];
  try {
    found = await lookup(address.host);
  } catch {
    throw new PeerUnreachable(`找不到“${address.host}”：检查名字，或确认这台电脑和它都连着 Tailscale。`);
  }
  const ip = found.map(normalizeAddress).find(reachable);
  if (!ip)
    throw new PeerRefused(
      400,
      `“${address.host}”不是 Tailscale 里的地址。只支持 Tailscale，好让配对码和任务只走加密的 Tailscale 网络。`,
    );
  return { host: ip, port: address.port };
}

export type PeerFetch = typeof fetch;
export type PeerRequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** The bearer token; kept in memory only for the request and never part of an error or log line. */
  token?: string;
  body?: unknown;
  /** Recheck host authorization after address resolution, immediately before each HTTP send. */
  beforeSend?: () => void;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: PeerFetch;
  lookup?: Lookup;
};

const maxReply = 1024 * 1024;

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxReply) {
      void reader.cancel().catch(() => undefined);
      throw new PeerRefused(502, '设备的回复太长了。');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One call to a device's peer API, with a timeout, a size limit and a checked reply. */
export async function peerRequest<T>(address: PeerAddress, options: PeerRequestOptions<T>): Promise<T> {
  const target = await resolvePeer(address, options.lookup);
  const method = options.method ?? 'GET';
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  options.beforeSend?.();
  try {
    response = await (options.fetch ?? fetch)(`http://${host}:${target.port}${options.path}`, {
      method,
      headers,
      signal,
      redirect: 'error',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new PeerUnreachable(timeout.aborted ? '设备没有及时回应。' : '连不上设备。');
  }
  let text: string;
  try {
    text = await readLimited(response);
  } catch (error) {
    if (error instanceof PeerRefused) throw error;
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new PeerUnreachable('和设备的连接断了。');
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new PeerRefused(502, '设备的回复无法读取（它可能不是 PugPort 设备节点）。');
  }
  if (!response.ok) {
    const reason = (data as { error?: unknown })?.error;
    throw new PeerRefused(
      response.status,
      typeof reason === 'string' && reason ? reason.slice(0, 500) : `设备返回了错误（HTTP ${response.status}）。`,
      response.status === 409 && (data as { code?: unknown })?.code === 'PEER_REQUEST_NOT_SENT',
    );
  }
  const parsed = options.schema.safeParse(data);
  if (!parsed.success) throw new PeerRefused(502, '设备的回复格式不对：两边的 PugPort 版本可能差太多。');
  return parsed.data;
}
