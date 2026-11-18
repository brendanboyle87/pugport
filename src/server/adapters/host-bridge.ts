import '../platform/under-test.ts';
import type { ExecuteContext } from '../../shared/types.ts';
import { redactError } from './process.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};

/** Names are supplied by the current run's authenticated host grant, never inferred from a model title. */
export async function hostBridgeToolNames(
  bridge: NonNullable<ExecuteContext['agentBridge']>,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const url = new URL(bridge.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('runtime-permission-or-sandbox-error');
  signal.throwIfAborted();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'pi-host-tools', method: 'tools/list', params: {} }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) throw new Error('runtime-permission-or-sandbox-error');
    const content = await response.text();
    if (content.length > 8 * 1024 * 1024) throw new Error('runtime-protocol-incompatible');
    const packet = object(JSON.parse(content)),
      tools = object(packet.result).tools;
    if (packet.error || !Array.isArray(tools) || tools.length > 256) throw new Error('runtime-protocol-incompatible');
    const names = tools.map((tool) => object(tool).name);
    if (
      names.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,119}$/.test(name)) ||
      new Set(names).size !== names.length
    )
      throw new Error('runtime-protocol-incompatible');
    return names as string[];
  } catch (error) {
    if (signal.aborted) throw new Error('operation-cancelled');
    throw new Error(redactError(error));
  }
}
